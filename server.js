require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const webpush = require('web-push');

// ── WEB PUSH (VAPID)
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BBi7Rj4vKyX1xuvYkG8940z02hL5T-FtSFSzvtS_mFNsnNopRSI3wmIjDdVKUCghYE0Stuxh71k6Kzj1jNTuHBY';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'uv5dwA25pm2zeq0fC-NGbjWTBx_XjeQ7HmaoCm5lick';
webpush.setVapidDetails('mailto:contact@fcutz.fr', VAPID_PUBLIC, VAPID_PRIVATE);

const app = express();

// ── CORS
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','x-fcutz-key','Accept'], credentials: false }));
app.options('*', cors());
app.use(express.json());

// ── DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, fname TEXT, lname TEXT, phone TEXT, email TEXT,
      fav TEXT DEFAULT 'Coupe Simple', visits INTEGER DEFAULT 0, spent NUMERIC DEFAULT 0, sumup_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY, client_id TEXT, service TEXT, price NUMERIC, duration INTEGER,
      date TEXT, time TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, client_id TEXT, service TEXT, amount NUMERIC,
      method TEXT DEFAULT 'sumup', date TEXT, time TEXT, tx_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY, type TEXT, icon TEXT, text TEXT, time TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      device TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ DB initialized');
}

function auth(req, res, next) {
  const key = req.headers['x-fcutz-key'];
  if (key !== process.env.FCUTZ_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── HEALTH
app.get('/', (req, res) => res.json({ status: '✅ FCUTZ Backend running', version: '1.0.0', timestamp: new Date().toISOString() }));
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── VAPID PUBLIC KEY (pour le dashboard)
app.get('/api/vapid-public', (req, res) => res.json({ publicKey: VAPID_PUBLIC }));

// ── SUMUP PROXY
app.all('/sumup/*', auth, async (req, res) => {
  const path = req.path.replace('/sumup', '');
  try {
    const opts = { method: req.method, headers: { 'Authorization': `Bearer ${process.env.SUMUP_API_KEY}`, 'Content-Type': 'application/json' } };
    if (req.method !== 'GET' && req.body) {
      const body = {...req.body};
      if (body.amount !== undefined) body.amount = parseFloat(parseFloat(body.amount).toFixed(2));
      // SumUp requires pay_to_email or merchant_code
      if (path.includes('/checkouts') && !body.pay_to_email && !body.merchant_code) {
        if (process.env.SUMUP_MERCHANT_EMAIL) body.pay_to_email = process.env.SUMUP_MERCHANT_EMAIL;
        if (process.env.SUMUP_MERCHANT_CODE) body.merchant_code = process.env.SUMUP_MERCHANT_CODE;
      }
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(`https://api.sumup.com${path}`, opts);
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { data = {error: text}; }
    console.log(`SumUp ${req.method} ${path} → ${r.status}`);
    res.status(r.status).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WEBHOOK SUMUP
app.post('/webhook/sumup', async (req, res) => {
  res.status(200).json({ received: true });
  const event = req.body;
  if (event.type === 'PAYMENT' && event.status === 'SUCCESSFUL') {
    const txId = event.transaction_code || event.id;
    const amount = parseFloat(event.amount) || 0;
    const date = (event.timestamp || new Date().toISOString()).slice(0,10);
    const time = (event.timestamp || new Date().toISOString()).slice(11,16);
    try {
      await pool.query(`INSERT INTO payments (id,service,amount,method,date,time,tx_id) VALUES ($1,$2,$3,'sumup',$4,$5,$6) ON CONFLICT DO NOTHING`,
        ['p_'+txId, event.product_summary||'SumUp', amount, date, time, txId]);
      await pool.query(`INSERT INTO notifications (type,icon,text,time) VALUES ('g','ti-credit-card',$1,'À l''instant')`,
        [`Paiement reçu — ${amount}€`]);
    } catch(e) { console.error('Webhook error:', e.message); }
  }
});


// ── PUSH SUBSCRIPTIONS
app.post('/api/push-subscribe', async (req, res) => {
  const { subscription, device } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Missing subscription' });
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, device)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh=$2, auth=$3, device=$4`,
      [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, device || '']
    );
    console.log('✅ Push subscription saved');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Helper : envoyer un push à tous les abonnés
async function sendPushToAll(payload) {
  let rows;
  try {
    const r = await pool.query('SELECT * FROM push_subscriptions');
    rows = r.rows;
  } catch(e) { return; }

  const payloadStr = JSON.stringify(payload);
  for (const row of rows) {
    const sub = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth }
    };
    try {
      await webpush.sendNotification(sub, payloadStr);
    } catch(e) {
      // Subscription expirée → la supprimer
      if (e.statusCode === 410 || e.statusCode === 404) {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [row.endpoint]).catch(()=>{});
        console.log('🗑  Push sub expired, removed');
      } else {
        console.warn('Push error:', e.message);
      }
    }
  }
}

// ── CLIENTS
app.get('/api/clients', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM clients ORDER BY lname, fname');
  res.json(r.rows.map(c => ({ id:c.id, fname:c.fname, lname:c.lname, phone:c.phone, email:c.email, fav:c.fav, visits:c.visits, spent:parseFloat(c.spent), sumupId:c.sumup_id })));
});
app.post('/api/clients', auth, async (req, res) => {
  const { id, fname, lname, phone, email, fav } = req.body;
  await pool.query(`INSERT INTO clients (id,fname,lname,phone,email,fav) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET fname=$2,lname=$3,phone=$4,email=$5,fav=$6`,
    [id, fname, lname, phone||'', email||'', fav||'Coupe Simple']);
  res.json({ ok: true });
});
app.post('/api/clients/bulk', auth, async (req, res) => {
  const { clients } = req.body; let added = 0;
  for (const c of clients) {
    try { await pool.query(`INSERT INTO clients (id,fname,lname,phone,email,fav,visits,spent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [c.id, c.fname, c.lname, c.phone||'', c.email||'', c.fav||'Coupe Simple', c.visits||0, c.spent||0]); added++; } catch(e) {}
  }
  res.json({ ok: true, added });
});
app.delete('/api/clients/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── APPOINTMENTS
app.get('/api/appointments', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM appointments ORDER BY date, time');
  res.json(r.rows.map(a => ({ id:a.id, clientId:a.client_id, service:a.service, price:parseFloat(a.price), duration:a.duration, date:a.date, time:a.time, status:a.status })));
});
app.post('/api/appointments', auth, async (req, res) => {
  const { id, clientId, service, price, duration, date, time, status, fname, lname } = req.body;

  // Check if this is a NEW appointment (not an update)
  const existing = await pool.query('SELECT id FROM appointments WHERE id=$1', [id]);
  const isNew = existing.rows.length === 0;

  await pool.query(`INSERT INTO appointments (id,client_id,service,price,duration,date,time,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET status=$8`,
    [id, clientId||null, service, price, duration, date, time, status||'pending']);

  // ── PUSH NOTIFICATION si nouveau RDV (from booking.html)
  if (isNew && status === 'pending') {
    // Récupérer le nom du client
    let clientName = fname ? `${fname} ${lname||''}`.trim() : 'Client';
    if (clientId) {
      try {
        const c = await pool.query('SELECT fname, lname FROM clients WHERE id=$1', [clientId]);
        if (c.rows.length > 0) clientName = `${c.rows[0].fname} ${c.rows[0].lname||''}`.trim();
      } catch(e) {}
    }

    const dateF = (date||'').split('-').reverse().join('/');
    const pushPayload = {
      title: `✂️ Nouveau RDV — ${clientName}`,
      body: `${service} · ${price}€ · ${duration||30}min\n${dateF} à ${time}`,
      apptId: id,
      url: '/?agenda=1'
    };

    // Push en arrière-plan (ne pas bloquer la réponse)
    sendPushToAll(pushPayload).catch(e => console.warn('Push failed:', e.message));

    // Aussi sauver dans notifications DB
    await pool.query(
      `INSERT INTO notifications (type,icon,text,time) VALUES ('g','ti-calendar-plus',$1,'À l''instant')`,
      [`Nouveau RDV — ${clientName} · ${service} · ${dateF} à ${time}`]
    ).catch(()=>{});

    console.log(`📲 Push envoyé → ${clientName} — ${service}`);
  }

  res.json({ ok: true });
});
app.post('/api/appointments/bulk', auth, async (req, res) => {
  const { appointments } = req.body; let added = 0;
  for (const a of appointments) {
    try { await pool.query(`INSERT INTO appointments (id,client_id,service,price,duration,date,time,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [a.id, a.clientId||null, a.service, a.price, a.duration, a.date, a.time, a.status||'pending']); added++; } catch(e) {}
  }
  res.json({ ok: true, added });
});
app.patch('/api/appointments/:id', auth, async (req, res) => {
  await pool.query('UPDATE appointments SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/appointments/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM appointments WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── PAYMENTS
app.get('/api/payments', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM payments ORDER BY date DESC, time DESC LIMIT 200');
  res.json(r.rows.map(p => ({ id:p.id, clientId:p.client_id, service:p.service, amount:parseFloat(p.amount), method:p.method, date:p.date, time:p.time, txId:p.tx_id })));
});
app.post('/api/payments', auth, async (req, res) => {
  const { id, clientId, service, amount, method, date, time, txId } = req.body;
  await pool.query(`INSERT INTO payments (id,client_id,service,amount,method,date,time,tx_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [id, clientId||null, service, amount, method||'sumup', date, time, txId||id]);
  if (clientId) await pool.query('UPDATE clients SET spent=spent+$1, visits=visits+1 WHERE id=$2', [amount, clientId]);
  res.json({ ok: true });
});

// ── NOTIFICATIONS
app.get('/api/notifications', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 20');
  res.json(r.rows.map(n => ({ type:n.type, icon:n.icon, text:n.text, time:n.time })));
});

// ── SYNC
app.post('/api/sync/transactions', auth, async (req, res) => {
  try {
    const r = await fetch('https://api.sumup.com/v0.1/me/transactions/history?limit=100',
      { headers: { 'Authorization': `Bearer ${process.env.SUMUP_API_KEY}` } });
    const data = await r.json();
    const items = data.items || [];
    let added = 0;
    for (const tx of items) {
      const txId = tx.transaction_code || tx.id;
      try {
        await pool.query(`INSERT INTO payments (id,service,amount,method,date,time,tx_id) VALUES ($1,$2,$3,'sumup',$4,$5,$6) ON CONFLICT DO NOTHING`,
          ['p_'+txId, tx.product_summary||'Carte SumUp', parseFloat(tx.amount)||0, (tx.timestamp||'').slice(0,10), (tx.timestamp||'').slice(11,16), txId]);
        added++;
      } catch(e) {}
    }
    res.json({ ok: true, added, total: items.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sync/customers', auth, async (req, res) => {
  try {
    const r = await fetch('https://api.sumup.com/v0.1/customers?limit=200',
      { headers: { 'Authorization': `Bearer ${process.env.SUMUP_API_KEY}` } });
    const data = await r.json();
    const customers = Array.isArray(data) ? data : (data.items || []);
    let added = 0;
    for (const c of customers) {
      try {
        await pool.query(`INSERT INTO clients (id,fname,lname,phone,email,fav,sumup_id) VALUES ($1,$2,$3,$4,$5,'Coupe Simple',$6) ON CONFLICT DO NOTHING`,
          ['su_'+c.customer_id, c.personal_details?.first_name||'Client', c.personal_details?.last_name||'',
           c.personal_details?.phone||'', c.personal_details?.email||'', c.customer_id]);
        added++;
      } catch(e) {}
    }
    res.json({ ok: true, added });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── START — utilise le PORT de Railway automatiquement
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`🚀 FCUTZ Backend on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
