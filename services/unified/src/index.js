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

    // Run rewards migration
    try {
      const rewardsMigration = require('fs').readFileSync(require('path').join(__dirname, 'rewards_migration.sql'), 'utf8');
      await pool.query(rewardsMigration);
      console.log('Rewards tables verified');
    } catch (e) { console.log('Rewards migration note:', e.message); }

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

// ===== CROP REMINDER SCHEDULER =====
async function runCropReminderScheduler() {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Find registrations with reminders due today
    const { rows: dueRegs } = await pool.query(
      "SELECT r.*, f.name as farmer_name, f.phone, f.language FROM farmer_crop_registrations r JOIN farmers f ON f.id = r.farmer_id WHERE r.status='active' AND r.next_reminder_date <= $1",
      [today]
    );

    if (dueRegs.length === 0) return;
    console.log('[Scheduler] ' + dueRegs.length + ' crop reminders due today');

    const axios = require('axios');
    const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;

    for (const reg of dueRegs) {
      try {
        const sowDate = new Date(reg.sow_date);
        const daysSinceSow = Math.floor((new Date() - sowDate) / (1000 * 60 * 60 * 24));

        // Find the template for today's stage
        const { rows: templates } = await pool.query(
          "SELECT * FROM crop_calendar_templates WHERE LOWER(crop)=LOWER($1) AND day_offset <= $2 AND id NOT IN (SELECT template_id FROM crop_reminders_log WHERE registration_id=$3 AND template_id IS NOT NULL) ORDER BY day_offset DESC LIMIT 1",
          [reg.crop, daysSinceSow, reg.id]
        );

        if (templates.length === 0) {
          // All reminders sent for this crop, mark as completed
          await pool.query("UPDATE farmer_crop_registrations SET status='completed', updated_at=NOW() WHERE id=$1", [reg.id]);
          continue;
        }

        const template = templates[0];
        const lang = reg.language || 'hi';
        let message = lang === 'hi' ? template.message_hi : template.message_en;

        // Weather check if template is weather-sensitive
        if (template.is_weather_sensitive || template.skip_if_rain) {
          try {
            const weatherResp = await axios.get('https://api.openweathermap.org/data/2.5/weather?q=' + (reg.district || 'Delhi') + ',IN&appid=' + process.env.OPENWEATHER_API_KEY + '&units=metric').catch(() => null);
            if (weatherResp && weatherResp.data) {
              const weather = weatherResp.data;
              const isRaining = weather.weather && weather.weather[0] && ['Rain', 'Drizzle', 'Thunderstorm'].includes(weather.weather[0].main);
              
              if (template.skip_if_rain && isRaining) {
                message = (lang === 'hi') 
                  ? '??? Aaj baarish ho rahi hai, isliye sinchai ki zaroorat nahi hai. Kal ka mausam dekhein.'
                  : '??? It is raining today, so no irrigation needed. Check weather tomorrow.';
              } else if (template.is_weather_sensitive && weather.main) {
                const temp = Math.round(weather.main.temp);
                message += (lang === 'hi')
                  ? '\n\n??? Aaj ka mausam: ' + temp + '�C, ' + (weather.weather[0].description || '')
                  : '\n\n??? Today\'s weather: ' + temp + '�C, ' + (weather.weather[0].description || '');
              }
            }
          } catch(wErr) { /* weather check failed, send without it */ }
        }

        // Add product suggestion if available
        if (template.product_suggestion) {
          message += (lang === 'hi')
            ? '\n\n?? Suggested: ' + template.product_suggestion + ' - Zyada jankari ke liye "product" likhen.'
            : '\n\n?? Suggested: ' + template.product_suggestion + ' - Type "product" for more info.';
        }

        // Add completion prompt
        message += (lang === 'hi')
          ? '\n\n? Kaam ho gaya? "done" likhen | ? Nahi hua? "skip" likhen'
          : '\n\nDone? Reply "done" | Not yet? Reply "skip"';

        // Send WhatsApp message
        const sendResp = await axios.post(
          'https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages',
          {
            messaging_product: 'whatsapp',
            to: reg.phone,
            type: 'text',
            text: { body: '?? *Crop Calendar - ' + reg.crop.charAt(0).toUpperCase() + reg.crop.slice(1) + '*\n(' + template.stage_name + ')\n\n' + message }
          },
          { headers: { 'Authorization': 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' } }
        );

        // Log the reminder
        await pool.query(
          "INSERT INTO crop_reminders_log (registration_id, farmer_id, template_id, stage_name, message_sent, weather_context) VALUES ($1,$2,$3,$4,$5,$6)",
          [reg.id, reg.farmer_id, template.id, template.stage_name, message, null]
        );

        // Update next reminder date
        const { rows: nextTemplate } = await pool.query(
          "SELECT day_offset FROM crop_calendar_templates WHERE LOWER(crop)=LOWER($1) AND day_offset > $2 ORDER BY day_offset LIMIT 1",
          [reg.crop, template.day_offset]
        );
        
        if (nextTemplate.length > 0) {
          const nextDate = new Date(reg.sow_date);
          nextDate.setDate(nextDate.getDate() + nextTemplate[0].day_offset);
          await pool.query("UPDATE farmer_crop_registrations SET next_reminder_date=$1, updated_at=NOW() WHERE id=$2", [nextDate.toISOString().split('T')[0], reg.id]);
        } else {
          await pool.query("UPDATE farmer_crop_registrations SET status='completed', updated_at=NOW() WHERE id=$1", [reg.id]);
        }

        console.log('[Scheduler] Sent reminder to ' + reg.farmer_name + ' (' + reg.crop + ' - ' + template.stage_name + ')');
      } catch(regErr) {
        console.log('[Scheduler] Error for reg ' + reg.id + ':', regErr.message);
      }
    }
  } catch(e) {
    console.log('[Scheduler] Error:', e.message);
  }
}

// Run scheduler every hour
setInterval(runCropReminderScheduler, 60 * 60 * 1000);
// Also run once 30 seconds after startup
setTimeout(runCropReminderScheduler, 30000);
console.log('[Scheduler] Crop reminder scheduler initialized (runs hourly)');


app.listen(PORT, () => {
  console.log(`VartMap Unified Service running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Admin API: http://localhost:${PORT}/api/v1/...`);
  console.log(`Gateway webhook: http://localhost:${PORT}/webhook`);
});
