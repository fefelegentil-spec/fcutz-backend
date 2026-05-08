require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS — autoriser ton site Netlify
app.use(cors({
  origin: ['https://*.netlify.app', 'http://localhost', 'file://'],
  methods: ['GET','POST','PUT','DELETE'],
  allowedHeaders: ['Content-Type','Authorization','x-fcutz-key']
}));
app.use(express.json());

// ── DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── INIT DB TABLES
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      fname TEXT, lname TEXT, phone TEXT, email TEXT,
      fav TEXT DEFAULT 'Coupe Simple',
      visits INTEGER DEFAULT 0,
      spent NUMERIC DEFAULT 0,
      sumup_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      service TEXT, price NUMERIC, duration INTEGER,
      date TEXT, time TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      service TEXT, amount NUMERIC,
      method TEXT DEFAULT 'sumup',
      date TEXT, time TEXT,
      tx_id TEXT UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      type TEXT, icon TEXT, text TEXT, time TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ DB initialized');
}

// ── AUTH MIDDLEWARE (clé secrète simple)
function auth(req, res, next) {
  const key = req.headers['x-fcutz-key'];
  if (key !== process.env.FCUTZ_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── SUMUP API PROXY (évite CORS côté browser)
app.all('/sumup/*', auth, async (req, res) => {
  const path = req.path.replace('/sumup', '');
  const url = `https://api.sumup.com${path}`;
  try {
    const opts = {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${process.env.SUMUP_API_KEY}`,
        'Content-Type': 'application/json'
      }
    };
    if (req.method !== 'GET' && req.body) opts.body = JSON.stringify(req.body);
    const r = await fetch(url, opts);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WEBHOOK SUMUP (paiements en temps réel)
app.post('/webhook/sumup', async (req, res) => {
  const event = req.body;
  console.log('📥 SumUp webhook:', event.type, event.id);
  res.status(200).json({ received: true });

  if (event.type === 'PAYMENT' && event.status === 'SUCCESSFUL') {
    const tx = event;
    const id = 'p_' + (tx.transaction_code || tx.id || Date.now());
    const amount = parseFloat(tx.amount) || 0;
    const date = (tx.timestamp || new Date().toISOString()).slice(0,10);
    const time = (tx.timestamp || new Date().toISOString()).slice(11,16);
    const service = tx.product_summary || 'Carte SumUp';

    // Find client by email if available
    let clientId = null;
    if (tx.card?.name) {
      const r = await pool.query('SELECT id FROM clients WHERE LOWER(fname || \' \' || lname) LIKE LOWER($1) LIMIT 1', [`%${tx.card.name}%`]);
      if (r.rows.length) clientId = r.rows[0].id;
    }

    await pool.query(`
      INSERT INTO payments (id, client_id, service, amount, method, date, time, tx_id)
      VALUES ($1,$2,$3,$4,'sumup',$5,$6,$7)
      ON CONFLICT (tx_id) DO NOTHING
    `, [id, clientId, service, amount, date, time, tx.transaction_code || tx.id]);

    // Update client stats
    if (clientId) {
      await pool.query('UPDATE clients SET spent=spent+$1, visits=visits+1 WHERE id=$2', [amount, clientId]);
    }

    // Add notification
    await pool.query(`INSERT INTO notifications (type,icon,text,time) VALUES ('g','ti-credit-card',$1,'À l''instant')`,
      [`Paiement reçu — ${service} — ${amount}€`]);

    console.log(`✅ Payment recorded: ${amount}€ - ${service}`);
  }
});

// ── CLIENTS API
app.get('/api/clients', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM clients ORDER BY lname, fname');
  res.json(r.rows.map(c => ({
    id: c.id, fname: c.fname, lname: c.lname, phone: c.phone,
    email: c.email, fav: c.fav, visits: c.visits,
    spent: parseFloat(c.spent), sumupId: c.sumup_id
  })));
});

app.post('/api/clients', auth, async (req, res) => {
  const { id, fname, lname, phone, email, fav } = req.body;
  await pool.query(`
    INSERT INTO clients (id,fname,lname,phone,email,fav)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO UPDATE SET fname=$2,lname=$3,phone=$4,email=$5,fav=$6
  `, [id, fname, lname, phone||'', email||'', fav||'Coupe Simple']);
  res.json({ ok: true });
});

app.post('/api/clients/bulk', auth, async (req, res) => {
  const { clients } = req.body;
  let added = 0;
  for (const c of clients) {
    try {
      await pool.query(`
        INSERT INTO clients (id,fname,lname,phone,email,fav,visits,spent)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO NOTHING
      `, [c.id, c.fname, c.lname, c.phone||'', c.email||'', c.fav||'Coupe Simple', c.visits||0, c.spent||0]);
      added++;
    } catch(e) { console.warn('Client skip:', e.message); }
  }
  res.json({ ok: true, added });
});

app.delete('/api/clients/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── APPOINTMENTS API
app.get('/api/appointments', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM appointments ORDER BY date, time');
  res.json(r.rows.map(a => ({
    id: a.id, clientId: a.client_id, service: a.service,
    price: parseFloat(a.price), duration: a.duration,
    date: a.date, time: a.time, status: a.status
  })));
});

app.post('/api/appointments', auth, async (req, res) => {
  const { id, clientId, service, price, duration, date, time, status } = req.body;
  await pool.query(`
    INSERT INTO appointments (id,client_id,service,price,duration,date,time,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET status=$8
  `, [id, clientId||null, service, price, duration, date, time, status||'pending']);
  res.json({ ok: true });
});

app.post('/api/appointments/bulk', auth, async (req, res) => {
  const { appointments } = req.body;
  let added = 0;
  for (const a of appointments) {
    try {
      await pool.query(`
        INSERT INTO appointments (id,client_id,service,price,duration,date,time,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO NOTHING
      `, [a.id, a.clientId||null, a.service, a.price, a.duration, a.date, a.time, a.status||'pending']);
      added++;
    } catch(e) {}
  }
  res.json({ ok: true, added });
});

app.patch('/api/appointments/:id', auth, async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE appointments SET status=$1 WHERE id=$2', [status, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/appointments/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM appointments WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── PAYMENTS API
app.get('/api/payments', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM payments ORDER BY date DESC, time DESC LIMIT 200');
  res.json(r.rows.map(p => ({
    id: p.id, clientId: p.client_id, service: p.service,
    amount: parseFloat(p.amount), method: p.method,
    date: p.date, time: p.time, txId: p.tx_id
  })));
});

app.post('/api/payments', auth, async (req, res) => {
  const { id, clientId, service, amount, method, date, time, txId } = req.body;
  await pool.query(`
    INSERT INTO payments (id,client_id,service,amount,method,date,time,tx_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (tx_id) DO NOTHING
  `, [id, clientId||null, service, amount, method||'sumup', date, time, txId||id]);
  if (clientId) {
    await pool.query('UPDATE clients SET spent=spent+$1, visits=visits+1 WHERE id=$2', [amount, clientId]);
  }
  res.json({ ok: true });
});

// ── NOTIFICATIONS API
app.get('/api/notifications', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 20');
  res.json(r.rows.map(n => ({ type: n.type, icon: n.icon, text: n.text, time: n.time })));
});

// ── SYNC SUMUP TRANSACTIONS
app.post('/api/sync/transactions', auth, async (req, res) => {
  try {
    const r = await fetch('https://api.sumup.com/v0.1/me/transactions/history?limit=100', {
      headers: { 'Authorization': `Bearer ${process.env.SUMUP_API_KEY}` }
    });
    const data = await r.json();
    const items = data.items || data || [];
    let added = 0;
    for (const tx of items) {
      const txId = tx.transaction_code || tx.id;
      const id = 'p_' + txId;
      const amount = parseFloat(tx.amount) || 0;
      const date = (tx.timestamp || '').slice(0,10) || new Date().toISOString().slice(0,10);
      const time = (tx.timestamp || '').slice(11,16) || '00:00';
      const service = tx.product_summary || 'Carte SumUp';
      try {
        await pool.query(`
          INSERT INTO payments (id,service,amount,method,date,time,tx_id)
          VALUES ($1,$2,$3,'sumup',$4,$5,$6)
          ON CONFLICT (tx_id) DO NOTHING
        `, [id, service, amount, date, time, txId]);
        added++;
      } catch(e) {}
    }
    res.json({ ok: true, added, total: items.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SYNC SUMUP CUSTOMERS
app.post('/api/sync/customers', auth, async (req, res) => {
  try {
    const r = await fetch('https://api.sumup.com/v0.1/customers?limit=200', {
      headers: { 'Authorization': `Bearer ${process.env.SUMUP_API_KEY}` }
    });
    const data = await r.json();
    const customers = Array.isArray(data) ? data : (data.items || []);
    let added = 0;
    for (const c of customers) {
      const id = 'su_' + c.customer_id;
      const fname = c.personal_details?.first_name || 'Client';
      const lname = c.personal_details?.last_name || '';
      const phone = c.personal_details?.phone || '';
      const email = c.personal_details?.email || '';
      try {
        await pool.query(`
          INSERT INTO clients (id,fname,lname,phone,email,fav,sumup_id)
          VALUES ($1,$2,$3,$4,$5,'Coupe Simple',$6)
          ON CONFLICT (id) DO NOTHING
        `, [id, fname, lname, phone, email, c.customer_id]);
        added++;
      } catch(e) {}
    }
    res.json({ ok: true, added });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK
app.get('/', (req, res) => res.json({ 
  status: '✅ FCUTZ Backend running', 
  version: '1.0.0',
  timestamp: new Date().toISOString()
}));

// ── START
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 FCUTZ Backend on port ${PORT}`));
}).catch(e => {
  console.error('DB init failed:', e.message);
  process.exit(1);
});
