
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const app = express();
const VERIFY_TOKEN = "fcutz2026secret";
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
  const { id, clientId, service, price, duration, date, time, status } = req.body;
  await pool.query(`INSERT INTO appointments (id,client_id,service,price,duration,date,time,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET status=$8`,
    [id, clientId||null, service, price, duration, date, time, status||'pending']);
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

app.get('/webhooks/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Instagram webhook vérifié');
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhooks/instagram', (req, res) => {
  console.log("🔥 WEBHOOK HIT !");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});


  // 👉 plus tard ici :
  // - analyse message
  // - création RDV
  // - réponse automatique

  res.sendStatus(200);
});

// ── START — utilise le PORT de Railway automatiquement
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`🚀 FCUTZ Backend on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
