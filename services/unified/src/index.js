// ============================================================
// VartMap Unified Service
// Admin API + WhatsApp Gateway + Dashboard (Single Process)
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));

// --- DATABASE (shared) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: false
});
pool.on('error', (err) => console.error('Pool error:', err.message));
pool.query('SELECT NOW()').then(() => { console.log('Database connected');

// --- Add Finance menu item if not exists ---
pool.query("SELECT id FROM bot_menu_items WHERE menu_key='hisaab'").then(r => {
  if (r.rows.length === 0) {
    pool.query("INSERT INTO bot_menu_items (menu_key, emoji, title_hi, title_en, description_hi, description_en, action_type, action_value, is_active, sort_order) VALUES ('hisaab', '📒', 'Hisaab-Kitaab', 'Farm Finance', 'Aay-kharch ka hisaab rakhein', 'Track income & expenses', 'keyword', 'hisaab', true, 8)").then(() => console.log('Finance menu item added')).catch(() => {});
  }
}).catch(() => {});

}).catch(e => console.error('DB error:', e.message));
setInterval(async () => {
  try { await pool.query('SELECT 1'); } catch (e) { console.error('DB keepalive failed:', e.message); }
}, 20000);

// --- REDIS (shared, optional) ---
let redis = null;
try {
  if (process.env.REDIS_URL) {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: (t) => (t > 3 ? null : Math.min(t * 200, 2000)) });
    redis.on('connect', () => console.log('Redis connected'));
    redis.on('error', (e) => console.error('Redis error:', e.message));
  }
} catch (e) { console.log('Redis not available'); }

// --- HEALTH CHECK (Render needs this) ---
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'vartmap-unified', timestamp: new Date().toISOString(), database: pool.totalCount > 0 ? 'connected' : 'unknown', redis: redis ? 'connected' : 'not configured' });
});

// --- MOUNT ADMIN API ROUTES ---
const setupAdminAPI = require('./adminAPI');
setupAdminAPI(app, pool);
console.log('Admin API routes mounted');

// --- MOUNT WHATSAPP GATEWAY ROUTES ---
const setupGateway = require('./gateway');
setupGateway(app, pool, redis);
console.log('WhatsApp Gateway routes mounted');

// --- SERVE DASHBOARD (static files, after API routes) ---
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/spin/:wheelId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'spin.html'));
});
app.get('/my-prizes', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'prizes.html'));
});
app.get('/my-loyalty', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'loyalty.html'));
});

// Catch-all: serve dashboard for any non-API route
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/webhook')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// --- START ---
app.listen(PORT, () => {
  console.log(`VartMap Unified Service running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Admin API: http://localhost:${PORT}/api/v1/...`);
  console.log(`Gateway webhook: http://localhost:${PORT}/webhook`);
});
