/* ═══════════════════════════════════════════════════════════
   FCUTZ BACKEND — Express + PostgreSQL + SumUp
   Routes : clients, appointments, payments, dispo, sumup
   ═══════════════════════════════════════════════════════════ */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const webpush = require('web-push');

// ─── POSTGRES ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ─── WEB PUSH (VAPID) ────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BBi7Rj4vKyX1xuvYkG8940z02hL5T-FtSFSzvtS_mFNsnNopRSI3wmIjDdVKUCghYE0Stuxh71k6Kzj1jNTuHBY';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'uv5dwA25pm2zeq0fC-NGbjWTBx_XjeQ7HmaoCm5lick';
webpush.setVapidDetails('mailto:contact@fcutz.fr', VAPID_PUBLIC, VAPID_PRIVATE);

// ─── APP ─────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','x-fcutz-key','Accept'],
  credentials: false,
}));
app.options('*', cors());
app.use(express.json({ limit: '2mb' }));

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────
function auth(req, res, next){
  const expected = process.env.FCUTZ_SECRET || 'fcutz2026secret';
  const key = req.headers['x-fcutz-key'];
  if(key !== expected){
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── DB INIT ─────────────────────────────────────────────────
async function initDB(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      fname TEXT,
      lname TEXT,
      phone TEXT,
      email TEXT,
      fav TEXT DEFAULT 'Coupe Simple',
      visits INTEGER DEFAULT 0,
      spent NUMERIC DEFAULT 0,
      sumup_id TEXT,
      last_visit DATE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      client_name TEXT,
      service TEXT,
      price NUMERIC,
      duration INTEGER,
      date TEXT,
      time TEXT,
      status TEXT DEFAULT 'pending',
      note TEXT,
      source TEXT DEFAULT 'dashboard',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      client_name TEXT,
      service TEXT,
      amount NUMERIC,
      method TEXT DEFAULT 'sumup',
      date TEXT,
      time TEXT,
      tx_id TEXT,
      checkout_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      type TEXT,
      icon TEXT,
      text TEXT,
      time TEXT,
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

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS client_push_subs (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      p256dh TEXT,
      auth TEXT,
      notify_24h TIMESTAMPTZ,
      notify_2h TIMESTAMPTZ,
      message_24h TEXT,
      message_2h TEXT,
      booking_id TEXT,
      sent_24h BOOLEAN DEFAULT false,
      sent_2h BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
    CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id);
    CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date);
    CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);
    CREATE INDEX IF NOT EXISTS idx_clients_sumup ON clients(sumup_id);
  `);
  console.log('✅ DB initialized');
}

// ─── HEALTH ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'FCUTZ Backend running',
    version: '2.0.0',
    time: new Date().toISOString(),
    routes: ['/api/clients','/api/appointments','/api/payments','/api/dispo','/sumup/checkout','/sumup/sync-customers','/sumup/balance','/sumup/webhook','/api/push/subscribe'],
  });
});
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── CLIENTS CRUD ────────────────────────────────────────────
app.get('/api/clients', auth, async (req, res) => {
  try{
    const r = await pool.query('SELECT * FROM clients ORDER BY spent DESC, lname ASC');
    res.json(r.rows.map(rowToClient));
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.get('/api/clients/:id', auth, async (req, res) => {
  try{
    const r = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if(!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rowToClient(r.rows[0]));
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.post('/api/clients', auth, async (req, res) => {
  try{
    const c = req.body;
    const id = c.id || ('c_' + Date.now().toString(36));
    await pool.query(`
      INSERT INTO clients (id, fname, lname, phone, email, fav, visits, spent, sumup_id, last_visit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO UPDATE SET
        fname=EXCLUDED.fname, lname=EXCLUDED.lname, phone=EXCLUDED.phone,
        email=EXCLUDED.email, fav=EXCLUDED.fav, visits=EXCLUDED.visits,
        spent=EXCLUDED.spent, sumup_id=EXCLUDED.sumup_id, last_visit=EXCLUDED.last_visit,
        updated_at=NOW()
    `, [id, c.fname||'', c.lname||'', c.phone||'', c.email||'', c.fav||'Coupe Simple', c.visits||0, c.spent||0, c.sumupId||c.sumup_id||null, c.lastVisit||c.last_visit||null]);
    const r = await pool.query('SELECT * FROM clients WHERE id=$1', [id]);
    res.json(rowToClient(r.rows[0]));
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.put('/api/clients/:id', auth, async (req, res) => {
  try{
    const c = req.body;
    await pool.query(`
      UPDATE clients SET fname=$2, lname=$3, phone=$4, email=$5, fav=$6,
        visits=$7, spent=$8, sumup_id=$9, last_visit=$10, updated_at=NOW()
      WHERE id=$1
    `, [req.params.id, c.fname||'', c.lname||'', c.phone||'', c.email||'', c.fav||'Coupe Simple', c.visits||0, c.spent||0, c.sumupId||c.sumup_id||null, c.lastVisit||c.last_visit||null]);
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.delete('/api/clients/:id', auth, async (req, res) => {
  try{
    await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

function rowToClient(row){
  if(!row) return null;
  return {
    id: row.id, fname: row.fname, lname: row.lname,
    phone: row.phone, email: row.email, fav: row.fav,
    visits: row.visits, spent: parseFloat(row.spent || 0),
    sumupId: row.sumup_id, lastVisit: row.last_visit,
    created_at: row.created_at,
  };
}

// ─── APPOINTMENTS CRUD ───────────────────────────────────────
// Public endpoint (no auth required for reading) — used by booking.html to show taken slots
app.get('/api/appointments', async (req, res) => {
  try{
    const { from, to } = req.query;
    let q = 'SELECT * FROM appointments';
    const params = [];
    if(from && to){ q += ' WHERE date BETWEEN $1 AND $2'; params.push(from, to); }
    else if(from){ q += ' WHERE date >= $1'; params.push(from); }
    q += ' ORDER BY date ASC, time ASC';
    const r = await pool.query(q, params);
    res.json(r.rows.map(rowToAppt));
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.get('/api/appointments/:id', auth, async (req, res) => {
  try{
    const r = await pool.query('SELECT * FROM appointments WHERE id=$1', [req.params.id]);
    if(!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rowToAppt(r.rows[0]));
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.post('/api/appointments', auth, async (req, res) => {
  try{
    const a = req.body;
    const id = a.id || ('a_' + Date.now().toString(36));
    await pool.query(`
      INSERT INTO appointments (id, client_id, client_name, service, price, duration, date, time, status, note, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET
        client_id=EXCLUDED.client_id, client_name=EXCLUDED.client_name,
        service=EXCLUDED.service, price=EXCLUDED.price, duration=EXCLUDED.duration,
        date=EXCLUDED.date, time=EXCLUDED.time, status=EXCLUDED.status,
        note=EXCLUDED.note, source=EXCLUDED.source, updated_at=NOW()
    `, [id, a.clientId||a.client_id||null, a.clientName||a.client_name||'', a.service||'', a.price||0, a.duration||30, a.date, a.time, a.status||'pending', a.note||'', a.source||'dashboard']);
    const r = await pool.query('SELECT * FROM appointments WHERE id=$1', [id]);
    // Push notif if from booking
    if(a.source === 'booking'){
      sendPushToAll('Nouveau RDV', `${a.clientName || 'Client'} — ${a.service} le ${a.date} à ${a.time}`).catch(()=>{});
    }
    res.json(rowToAppt(r.rows[0]));
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.put('/api/appointments/:id', auth, async (req, res) => {
  try{
    const a = req.body;
    await pool.query(`
      UPDATE appointments SET
        client_id=$2, client_name=$3, service=$4, price=$5, duration=$6,
        date=$7, time=$8, status=$9, note=$10, updated_at=NOW()
      WHERE id=$1
    `, [req.params.id, a.clientId||a.client_id||null, a.clientName||a.client_name||'', a.service||'', a.price||0, a.duration||30, a.date, a.time, a.status||'pending', a.note||'']);
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.delete('/api/appointments/:id', auth, async (req, res) => {
  try{
    await pool.query('DELETE FROM appointments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

function rowToAppt(row){
  if(!row) return null;
  return {
    id: row.id, clientId: row.client_id, clientName: row.client_name,
    service: row.service, price: parseFloat(row.price || 0),
    duration: row.duration, date: row.date, time: row.time,
    status: row.status, note: row.note, source: row.source,
    createdAt: row.created_at,
  };
}

// ─── DISPO ─────────────────────────────────────────────────
// Default per-day schedule (used when no settings are stored)
const DEFAULT_HOURS = {
  lun:{ open:true,  start:'09:00', end:'19:00' },
  mar:{ open:true,  start:'09:00', end:'19:00' },
  mer:{ open:true,  start:'09:00', end:'19:00' },
  jeu:{ open:true,  start:'09:00', end:'19:00' },
  ven:{ open:true,  start:'09:00', end:'19:00' },
  sam:{ open:true,  start:'10:00', end:'19:00' },
  dim:{ open:false, start:'10:00', end:'18:00' },
};

async function getHoursConfig(){
  // Priority : hours JSON > legacy open_time/close_time/closed_days
  const raw = await getSetting('hours');
  if(raw){
    try{ const h = JSON.parse(raw); if(h && typeof h === 'object') return h; }catch(_){}
  }
  // Legacy fallback
  const open = (await getSetting('open_time')) || '09:00';
  const close = (await getSetting('close_time')) || '19:00';
  const closedRaw = (await getSetting('closed_days')) || '0';
  const closed = closedRaw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  const out = JSON.parse(JSON.stringify(DEFAULT_HOURS));
  const map = ['dim','lun','mar','mer','jeu','ven','sam'];
  map.forEach((k, idx) => {
    out[k] = { open: !closed.includes(idx), start: open, end: close };
  });
  return out;
}

async function getBlockedDays(){
  const raw = await getSetting('blocked_days');
  if(!raw) return [];
  try{ const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }catch(_){ return []; }
}

// GET /api/dispo                       → { days:{...}, blockedDays:[...] }
// GET /api/dispo?date=YYYY-MM-DD       → { date, slots:[{time, available}, ...] }
// Public endpoint (no auth required) — used by booking.html client
app.get('/api/dispo', async (req, res) => {
  try{
    const hours = await getHoursConfig();
    const blockedDays = await getBlockedDays();

    if(!req.query.date){
      return res.json({ days: hours, blockedDays });
    }

    const date = req.query.date;
    const duration = parseInt(req.query.duration) || 30;
    const map = ['dim','lun','mar','mer','jeu','ven','sam'];
    const dow = new Date(date).getDay();
    const dayKey = map[dow];
    const day = hours[dayKey];
    if(!day || !day.open) return res.json({ date, slots: [] });
    if(blockedDays.find(b => b.date === date)) return res.json({ date, slots: [] });

    const r = await pool.query(`SELECT time, duration FROM appointments WHERE date=$1 AND status NOT IN ('cancelled','noshow')`, [date]);
    const taken = r.rows.map(x => ({ start: toMin(x.time), end: toMin(x.time) + (x.duration || 30) }));

    const slots = [];
    const startMin = toMin(day.start || '09:00');
    const endMin = toMin(day.end || '19:00');
    for(let m = startMin; m + duration <= endMin; m += 15){
      const conflict = taken.some(t => m < t.end && m + duration > t.start);
      slots.push({ time: fromMin(m), available: !conflict });
    }
    res.json({ date, slots });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

// Public booking endpoint (no auth — site client)
app.post('/api/book', async (req, res) => {
  try{
    const b = req.body;
    if(!b.date || !b.time || !b.service){ return res.status(400).json({ error: 'Date, time, service required' }); }
    // Check conflict
    const dur = parseInt(b.duration) || 30;
    const r = await pool.query(`SELECT time, duration FROM appointments WHERE date=$1 AND status NOT IN ('cancelled','noshow')`, [b.date]);
    const startMin = toMin(b.time);
    const conflict = r.rows.some(x => {
      const xs = toMin(x.time), xe = xs + (x.duration || 30);
      return startMin < xe && startMin + dur > xs;
    });
    if(conflict) return res.status(409).json({ error: 'Slot taken' });

    // Create or link client
    let clientId = null;
    if(b.phone || b.email){
      const cr = await pool.query('SELECT id FROM clients WHERE phone=$1 OR email=$2 LIMIT 1', [b.phone||'', b.email||'']);
      if(cr.rows[0]) clientId = cr.rows[0].id;
      else {
        clientId = 'c_' + Date.now().toString(36);
        await pool.query(`INSERT INTO clients (id, fname, lname, phone, email, fav) VALUES ($1,$2,$3,$4,$5,$6)`,
          [clientId, b.fname||'', b.lname||'', b.phone||'', b.email||'', b.service]);
      }
    }

    const id = 'a_' + Date.now().toString(36);
    await pool.query(`
      INSERT INTO appointments (id, client_id, client_name, service, price, duration, date, time, status, note, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,'booking')
    `, [id, clientId, `${b.fname||''} ${b.lname||''}`.trim(), b.service, b.price||0, dur, b.date, b.time, b.note||'']);

    sendPushToAll('Nouveau RDV en ligne', `${b.fname||''} ${b.lname||''} — ${b.service} le ${b.date} à ${b.time}`, id).catch(()=>{});
    res.json({ ok: true, id });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

// ─── PAYMENTS CRUD ───────────────────────────────────────────
app.get('/api/payments', auth, async (req, res) => {
  try{
    const { from, to } = req.query;
    let q = 'SELECT * FROM payments';
    const params = [];
    if(from && to){ q += ' WHERE date BETWEEN $1 AND $2'; params.push(from, to); }
    q += ' ORDER BY date DESC, time DESC LIMIT 500';
    const r = await pool.query(q, params);
    res.json(r.rows.map(rowToPay));
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.post('/api/payments', auth, async (req, res) => {
  try{
    const p = req.body;
    const id = p.id || ('p_' + Date.now().toString(36));
    await pool.query(`
      INSERT INTO payments (id, client_id, client_name, service, amount, method, date, time, tx_id, checkout_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO UPDATE SET
        client_id=EXCLUDED.client_id, client_name=EXCLUDED.client_name,
        service=EXCLUDED.service, amount=EXCLUDED.amount, method=EXCLUDED.method,
        date=EXCLUDED.date, time=EXCLUDED.time, tx_id=EXCLUDED.tx_id, checkout_id=EXCLUDED.checkout_id
    `, [id, p.clientId||null, p.clientName||'', p.service||'', p.amount||0, p.method||'sumup', p.date, p.time, p.txId||null, p.checkoutId||null]);
    // Update client visits/spent
    if(p.clientId){
      await pool.query(`UPDATE clients SET visits=visits+1, spent=spent+$2, last_visit=$3 WHERE id=$1`,
        [p.clientId, p.amount||0, p.date]);
    }
    res.json({ ok: true, id });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.delete('/api/payments/:id', auth, async (req, res) => {
  try{
    await pool.query('DELETE FROM payments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

function rowToPay(row){
  if(!row) return null;
  return {
    id: row.id, clientId: row.client_id, clientName: row.client_name,
    service: row.service, amount: parseFloat(row.amount || 0),
    method: row.method, date: row.date, time: row.time,
    txId: row.tx_id, checkoutId: row.checkout_id,
    createdAt: row.created_at,
  };
}

// ─── SUMUP PROXY ─────────────────────────────────────────────
const SUMUP_API = 'https://api.sumup.com';

// Public endpoint (no auth required) — used by booking.html for client payment
app.post('/sumup/checkout', async (req, res) => {
  try{
    const { amount, description, key, merchant, return_url } = req.body;
    const apiKey = key || process.env.SUMUP_KEY || await getSetting('sumup_key');
    const merchantCode = merchant || process.env.SUMUP_MERCHANT || await getSetting('sumup_merchant');
    console.log('[DEBUG /sumup/checkout] amount:', amount, 'merchant:', merchantCode, 'key_received:', !!key);
    if(!apiKey || !merchantCode){ return res.status(400).json({ error: 'SumUp key/merchant missing' }); }
    const payload = {
      checkout_reference: 'fcutz_' + Date.now(),
      amount: parseFloat(amount),
      currency: 'EUR',
      merchant_code: merchantCode,
      description: description || 'FCUTZ',
    };
    if(return_url) payload.return_url = return_url;
    const r = await fetch(`${SUMUP_API}/v0.1/checkouts`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    console.log('[SumUp] status:', r.status, 'response:', JSON.stringify(data, null, 2));
    if(!r.ok){
      console.error('[SumUp ERROR]', data);
      return res.status(r.status).json({ error: data.message || 'SumUp error', details: data });
    }
    const checkoutUrl = data.hosted_checkout_url
      || `https://checkout.sumup.com/pay/${data.id}`
      || `https://pay.sumup.com/b2c/${data.id}`;
    res.json({
      checkout_id: data.id,
      checkout_url: checkoutUrl,
      hosted_checkout_url: data.hosted_checkout_url,
      checkout_reference: data.checkout_reference,
      amount: data.amount,
      status: data.status,
    });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.get('/sumup/balance', auth, async (req, res) => {
  try{
    const apiKey = req.query.key || process.env.SUMUP_KEY;
    if(!apiKey) return res.status(400).json({ error: 'SumUp key missing' });
    const r = await fetch(`${SUMUP_API}/v0.1/me/account`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await r.json();
    if(!r.ok) return res.status(r.status).json({ error: data.message || 'SumUp error' });
    res.json({ balance: data.balance, currency: data.currency || 'EUR' });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.post('/sumup/sync-customers', auth, async (req, res) => {
  try{
    const apiKey = req.body.key || process.env.SUMUP_KEY;
    if(!apiKey) return res.status(400).json({ error: 'SumUp key missing' });
    const r = await fetch(`${SUMUP_API}/v0.1/me/customers?limit=200`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await r.json();
    if(!r.ok) return res.status(r.status).json({ error: data.message || 'SumUp error' });
    const customers = data.items || data || [];
    res.json({ count: customers.length, customers });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

// SumUp transaction history (used for reconciliation)
app.get('/sumup/transactions', auth, async (req, res) => {
  try{
    const apiKey = req.query.key || process.env.SUMUP_KEY;
    if(!apiKey) return res.status(400).json({ error: 'SumUp key missing' });
    const limit = req.query.limit || '50';
    const r = await fetch(`${SUMUP_API}/v0.1/me/transactions/history?limit=${limit}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await r.json();
    if(!r.ok) return res.status(r.status).json({ error: data.message || 'SumUp error' });
    res.json(data);
  }catch(e){ res.status(500).json({ error: e.message }) }
});

// SumUp Webhook (no auth — uses signature)
app.post('/sumup/webhook', async (req, res) => {
  try{
    const event = req.body;
    if(event && event.event_type === 'checkout.completed'){
      const cid = event.id || event.payload?.id;
      const amount = event.payload?.amount || event.amount;
      const ref = event.payload?.checkout_reference || event.checkout_reference;
      // Insert payment if not exists
      const exists = await pool.query('SELECT 1 FROM payments WHERE checkout_id=$1', [cid]);
      if(!exists.rowCount){
        const id = 'p_' + Date.now().toString(36);
        const date = new Date().toISOString().slice(0,10);
        const time = new Date().toTimeString().slice(0,5);
        await pool.query(`
          INSERT INTO payments (id, service, amount, method, date, time, checkout_id)
          VALUES ($1,'SumUp',$2,'sumup',$3,$4,$5)
        `, [id, amount, date, time, cid]);
      }
    }
    res.json({ ok: true });
  }catch(e){
    console.error('webhook error', e);
    res.status(200).json({ ok: false }); // Always 200 for webhooks
  }
});

// ─── PUSH NOTIFICATIONS ──────────────────────────────────────
app.get('/api/push/vapid-public', (req, res) => res.json({ key: VAPID_PUBLIC }));

app.post('/api/push/subscribe', async (req, res) => {
  try{
    const { endpoint, keys, device } = req.body;
    if(!endpoint || !keys?.p256dh || !keys?.auth){
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    await pool.query(`
      INSERT INTO push_subscriptions (endpoint, p256dh, auth, device)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, device=EXCLUDED.device
    `, [endpoint, keys.p256dh, keys.auth, device || 'unknown']);
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

async function sendPushToAll(title, body, apptId){
  try{
    const r = await pool.query('SELECT endpoint, p256dh, auth FROM push_subscriptions');
    const payload = JSON.stringify({ title, body, type:'barber', apptId: apptId || null, icon:'/img/COUPE PREMIUM.png', badge:'/img/COUPE PREMIUM.png' });
    for(const sub of r.rows){
      try{
        await webpush.sendNotification({ endpoint: sub.endpoint, keys:{ p256dh: sub.p256dh, auth: sub.auth } }, payload);
      }catch(err){
        if(err.statusCode === 404 || err.statusCode === 410){
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
        }
      }
    }
  }catch(e){ console.warn('push error', e.message); }
}

// ─── CLIENT PUSH REMINDERS ───────────────────────────────────
app.post('/api/client-notify/subscribe', async (req, res) => {
  try{
    const { endpoint, keys, notify_24h, notify_2h, message_24h, message_2h, booking_id } = req.body;
    if(!endpoint || !keys?.p256dh || !keys?.auth){
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const id = 'cs_' + Date.now().toString(36);
    await pool.query(`
      INSERT INTO client_push_subs (id, endpoint, p256dh, auth, notify_24h, notify_2h, message_24h, message_2h, booking_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO NOTHING
    `, [id, endpoint, keys.p256dh, keys.auth, notify_24h || null, notify_2h || null, message_24h || null, message_2h || null, booking_id || null]);
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

// Scheduler — envoie les rappels client dus (toutes les 60s)
setInterval(async () => {
  try{
    const now = new Date().toISOString();
    const { rows } = await pool.query(`
      SELECT * FROM client_push_subs
      WHERE (sent_24h = false AND notify_24h IS NOT NULL AND notify_24h <= $1)
         OR (sent_2h  = false AND notify_2h  IS NOT NULL AND notify_2h  <= $1)
    `, [now]);
    for(const row of rows){
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      if(!row.sent_24h && row.notify_24h && new Date(row.notify_24h) <= new Date(now)){
        try{
          await webpush.sendNotification(sub, JSON.stringify({ title:'✂️ Rappel RDV — FCUTZ', body: row.message_24h || 'Ton RDV est demain !', type:'client' }));
        }catch(_){}
        await pool.query('UPDATE client_push_subs SET sent_24h=true WHERE id=$1', [row.id]);
      }
      if(!row.sent_2h && row.notify_2h && new Date(row.notify_2h) <= new Date(now)){
        try{
          await webpush.sendNotification(sub, JSON.stringify({ title:"✂️ C'est bientôt — FCUTZ", body: row.message_2h || 'Ton RDV est dans 2h !', type:'client' }));
        }catch(_){}
        await pool.query('UPDATE client_push_subs SET sent_2h=true WHERE id=$1', [row.id]);
      }
    }
  }catch(_){}
}, 60000);

// ─── SETTINGS ────────────────────────────────────────────────
async function getSetting(key){
  const r = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rows[0]?.value;
}
async function setSetting(key, value){
  await pool.query(`
    INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW())
    ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()
  `, [key, value]);
}

app.get('/api/settings', auth, async (req, res) => {
  try{
    const r = await pool.query('SELECT key, value FROM settings');
    const out = {};
    r.rows.forEach(row => out[row.key] = row.value);
    res.json(out);
  }catch(e){ res.status(500).json({ error: e.message }) }
});

app.post('/api/settings', auth, async (req, res) => {
  try{
    for(const [k, v] of Object.entries(req.body)){
      await setSetting(k, String(v));
    }
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: e.message }) }
});

// ─── HELPERS ─────────────────────────────────────────────────
function toMin(t){ const [h,m] = t.split(':').map(Number); return h*60 + m; }
function fromMin(min){ const h = Math.floor(min/60), m = min%60; return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0'); }

// ─── ERROR HANDLING ──────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found', path: req.path }));
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── START ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 FCUTZ Backend v2.0.0 running on port ${PORT}`);
      console.log(`📡 Routes: /api/clients · /api/appointments · /api/payments · /api/dispo · /sumup/*`);
    });
  })
  .catch(err => {
    console.error('❌ DB init failed:', err.message);
    process.exit(1);
  });
