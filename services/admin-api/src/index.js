const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10
});

// Auth middleware
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// Health
app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW()');
    res.json({ status: 'healthy', service: 'admin-api', timestamp: r.rows[0].now, database: 'connected' });
  } catch (e) { res.status(500).json({ status: 'unhealthy', error: e.message }); }
});

// ===== AUTH =====
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await pool.query('SELECT * FROM admin_users WHERE email=$1 AND status=$2', [email, 'active']);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    await pool.query('UPDATE admin_users SET last_login_at=NOW() WHERE id=$1', [user.id]);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== DASHBOARD =====
app.get('/api/v1/dashboard', auth, async (req, res) => {
  try {
    const farmers = await pool.query('SELECT COUNT(*) FROM farmers');
    const conv24 = await pool.query("SELECT COUNT(*) FROM conversations WHERE created_at > NOW() - INTERVAL '24 hours'");
    const active24 = await pool.query("SELECT COUNT(DISTINCT farmer_id) FROM conversations WHERE created_at > NOW() - INTERVAL '24 hours'");
    const conv7d = await pool.query("SELECT COUNT(*) FROM conversations WHERE created_at > NOW() - INTERVAL '7 days'");
    const newFarmers7d = await pool.query("SELECT COUNT(*) FROM farmers WHERE created_at > NOW() - INTERVAL '7 days'");
    const templates = await pool.query('SELECT COUNT(*) FROM message_templates');
    const campaigns = await pool.query("SELECT COUNT(*) FROM campaigns WHERE status='active' OR status='running'");
    const modPending = await pool.query("SELECT COUNT(*) FROM moderation_queue WHERE status='pending'");

    res.json({
      total_farmers: +farmers.rows[0].count,
      conversations_24h: +conv24.rows[0].count,
      active_farmers_24h: +active24.rows[0].count,
      conversations_7d: +conv7d.rows[0].count,
      new_farmers_7d: +newFarmers7d.rows[0].count,
      total_templates: +templates.rows[0].count,
      active_campaigns: +campaigns.rows[0].count,
      moderation_pending: +modPending.rows[0].count
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== FARMERS =====
app.get('/api/v1/farmers', auth, async (req, res) => {
  try {
    const { limit = 50, offset = 0, search, status, stage } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    let i = 1;
    if (search) { where += ` AND (name ILIKE $${i} OR phone ILIKE $${i} OR village ILIKE $${i})`; params.push(`%${search}%`); i++; }
    if (status) { where += ` AND status=$${i}`; params.push(status); i++; }
    if (stage) { where += ` AND onboarding_stage=$${i}`; params.push(stage); i++; }
    const r = await pool.query(`SELECT * FROM farmers ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i+1}`, [...params, +limit, +offset]);
    const total = await pool.query(`SELECT COUNT(*) FROM farmers ${where}`, params);
    res.json({ farmers: r.rows, total: +total.rows[0].count, limit: +limit, offset: +offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/farmers/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM farmers WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const convos = await pool.query('SELECT * FROM conversations WHERE farmer_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
    res.json({ farmer: r.rows[0], conversations: convos.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v1/farmers/:id', auth, async (req, res) => {
  try {
    const { name, language, village, pin_code, crops, status, land_holding_acres } = req.body;
    const r = await pool.query(
      `UPDATE farmers SET name=COALESCE($1,name), language=COALESCE($2,language), village=COALESCE($3,village),
       pin_code=COALESCE($4,pin_code), crops=COALESCE($5,crops), status=COALESCE($6,status),
       land_holding_acres=COALESCE($7,land_holding_acres), updated_at=NOW() WHERE id=$8 RETURNING *`,
      [name, language, village, pin_code, crops, status, land_holding_acres, req.params.id]
    );
    res.json({ farmer: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== CONVERSATIONS / REPLY =====
app.get('/api/v1/conversations', auth, async (req, res) => {
  try {
    const { limit = 50, offset = 0, farmer_id } = req.query;
    let where = farmer_id ? 'WHERE c.farmer_id=$1' : '';
    const params = farmer_id ? [farmer_id] : [];
    const i = params.length + 1;
    const r = await pool.query(
      `SELECT c.*, f.name as farmer_name, f.phone as farmer_phone FROM conversations c
       LEFT JOIN farmers f ON c.farmer_id=f.id ${where} ORDER BY c.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...params, +limit, +offset]
    );
    res.json({ conversations: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/conversations/reply', auth, async (req, res) => {
  try {
    const { farmer_id, message } = req.body;
    if (!farmer_id || !message) return res.status(400).json({ error: 'farmer_id and message required' });

    // Store outbound message
    const r = await pool.query(
      `INSERT INTO conversations (farmer_id, channel, direction, message_type, content, response_type, status, created_at)
       VALUES ($1, 'whatsapp', 'outbound', 'text', $2, 'manual_reply', 'pending', NOW()) RETURNING *`,
      [farmer_id, message]
    );

    // Get farmer phone
    const farmer = await pool.query('SELECT phone FROM farmers WHERE id=$1', [farmer_id]);
    if (!farmer.rows.length) return res.status(404).json({ error: 'Farmer not found' });

    // Send via WhatsApp Gateway
    const gatewayUrl = process.env.WA_GATEWAY_URL || process.env.INTELLIGENCE_SERVICE_URL;
    // For now just store it, actual sending will be done via gateway
    
    res.json({ conversation: r.rows[0], status: 'queued' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== TEMPLATES =====
app.get('/api/v1/templates', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM message_templates ORDER BY created_at DESC');
    res.json({ templates: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/templates', auth, async (req, res) => {
  try {
    const { name, language, category, template_text, variables, wa_template_name } = req.body;
    const r = await pool.query(
      `INSERT INTO message_templates (name, language, category, template_text, variables, wa_template_name, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',NOW()) RETURNING *`,
      [name, language || 'hi', category, template_text, variables || [], wa_template_name]
    );
    res.json({ template: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v1/templates/:id', auth, async (req, res) => {
  try {
    const { name, language, category, template_text, variables, wa_template_name, wa_approved, status } = req.body;
    const r = await pool.query(
      `UPDATE message_templates SET name=COALESCE($1,name), language=COALESCE($2,language), category=COALESCE($3,category),
       template_text=COALESCE($4,template_text), variables=COALESCE($5,variables), wa_template_name=COALESCE($6,wa_template_name),
       wa_approved=COALESCE($7,wa_approved), status=COALESCE($8,status), updated_at=NOW() WHERE id=$9 RETURNING *`,
      [name, language, category, template_text, variables, wa_template_name, wa_approved, status, req.params.id]
    );
    res.json({ template: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/v1/templates/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM message_templates WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== CAMPAIGNS =====
app.get('/api/v1/campaigns', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*, t.name as template_name FROM campaigns c LEFT JOIN message_templates t ON c.template_id=t.id ORDER BY c.created_at DESC`
    );
    res.json({ campaigns: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/campaigns', auth, async (req, res) => {
  try {
    const { name, template_id, target_criteria, scheduled_at } = req.body;
    // Count target farmers
    let targetCount = 0;
    const criteria = target_criteria || {};
    let where = "WHERE status='active'";
    if (criteria.district) where += ` AND district_id='${criteria.district}'`;
    if (criteria.crop) where += ` AND '${criteria.crop}'=ANY(crops)`;
    if (criteria.stage) where += ` AND onboarding_stage='${criteria.stage}'`;
    const count = await pool.query(`SELECT COUNT(*) FROM farmers ${where}`);
    targetCount = +count.rows[0].count;

    const r = await pool.query(
      `INSERT INTO campaigns (name, template_id, target_criteria, target_count, status, scheduled_at, created_by, created_at)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,NOW()) RETURNING *`,
      [name, template_id, criteria, targetCount, scheduled_at, req.user.id]
    );
    res.json({ campaign: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v1/campaigns/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const r = await pool.query('UPDATE campaigns SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [status, req.params.id]);
    res.json({ campaign: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== REWARDS =====
app.get('/api/v1/rewards', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.*, f.name as farmer_name, f.phone as farmer_phone FROM rewards r
       LEFT JOIN farmers f ON r.farmer_id=f.id ORDER BY r.created_at DESC LIMIT 100`
    );
    const stats = await pool.query(
      `SELECT type, COUNT(*) as count, SUM(points) as total_points FROM rewards GROUP BY type`
    );
    res.json({ rewards: r.rows, stats: stats.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/rewards', auth, async (req, res) => {
  try {
    const { farmer_id, type, points, description } = req.body;
    const r = await pool.query(
      `INSERT INTO rewards (farmer_id, type, points, description, status, created_at)
       VALUES ($1,$2,$3,$4,'earned',NOW()) RETURNING *`,
      [farmer_id, type, points, description]
    );
    res.json({ reward: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== REFERRALS =====
app.get('/api/v1/referrals', auth, async (req, res) => {
  try {
    const codes = await pool.query(
      `SELECT rc.*, f.name as farmer_name, f.phone as farmer_phone FROM referral_codes rc
       LEFT JOIN farmers f ON rc.farmer_id=f.id ORDER BY rc.created_at DESC`
    );
    const referrals = await pool.query(
      `SELECT r.*, f1.name as referrer_name, f2.name as referee_name FROM referrals r
       LEFT JOIN farmers f1 ON r.referrer_id=f1.id LEFT JOIN farmers f2 ON r.referee_id=f2.id ORDER BY r.created_at DESC LIMIT 100`
    );
    res.json({ codes: codes.rows, referrals: referrals.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== MODERATION =====
app.get('/api/v1/moderation', auth, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const r = await pool.query(
      `SELECT mq.*, f.name as farmer_name, f.phone as farmer_phone FROM moderation_queue mq
       LEFT JOIN farmers f ON mq.farmer_id=f.id WHERE mq.status=$1 ORDER BY mq.priority DESC, mq.created_at ASC`,
      [status]
    );
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/moderation/:id/action', auth, async (req, res) => {
  try {
    const { action, reason } = req.body;
    await pool.query(
      `INSERT INTO moderation_actions (queue_id, action, reason, action_by, created_at) VALUES ($1,$2,$3,$4,NOW())`,
      [req.params.id, action, reason, req.user.id]
    );
    await pool.query('UPDATE moderation_queue SET status=$1, updated_at=NOW() WHERE id=$2', [action === 'approve' ? 'approved' : 'rejected', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== SCHEMES =====
app.get('/api/v1/schemes', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM government_schemes ORDER BY created_at DESC');
    res.json({ schemes: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/schemes', auth, async (req, res) => {
  try {
    const { name, name_hi, department, level, state_code, description, description_hi, eligibility, benefits, benefits_hi, application_url, helpline, deadline } = req.body;
    const r = await pool.query(
      `INSERT INTO government_schemes (name,name_hi,department,level,state_code,description,description_hi,eligibility,benefits,benefits_hi,application_url,helpline,deadline,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active') RETURNING *`,
      [name, name_hi, department, level || 'central', state_code, description, description_hi, eligibility || {}, benefits, benefits_hi, application_url, helpline, deadline]
    );
    res.json({ scheme: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== MANDI PRICES =====
app.get('/api/v1/mandi-prices', auth, async (req, res) => {
  try {
    const { commodity, market, date } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    let i = 1;
    if (commodity) { where += ` AND commodity ILIKE $${i}`; params.push(`%${commodity}%`); i++; }
    if (market) { where += ` AND market_name ILIKE $${i}`; params.push(`%${market}%`); i++; }
    const r = await pool.query(`SELECT * FROM mandi_prices ${where} ORDER BY price_date DESC, commodity LIMIT 200`, params);
    res.json({ prices: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== PRODUCTS =====
app.get('/api/v1/products', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
    res.json({ products: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/products', auth, async (req, res) => {
  try {
    const { name, brand, category, subcategory, registration_number, active_ingredients, dosage, application_method, target_crops, target_pests, safety_info } = req.body;
    const r = await pool.query(
      `INSERT INTO products (name,brand,category,subcategory,registration_number,active_ingredients,dosage,application_method,target_crops,target_pests,safety_info,verified,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,'active') RETURNING *`,
      [name, brand, category, subcategory, registration_number, active_ingredients || {}, dosage, application_method, target_crops || [], target_pests || [], safety_info]
    );
    res.json({ product: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== AUDIT LOG =====
app.get('/api/v1/audit-log', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100');
    res.json({ logs: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== USAGE / ANALYTICS =====
app.get('/api/v1/analytics/usage', auth, async (req, res) => {
  try {
    const daily = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count, SUM(tokens_used) as tokens, SUM(cost_inr) as cost
       FROM usage_tracking WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date`
    );
    const byFeature = await pool.query(
      `SELECT feature, COUNT(*) as count FROM usage_tracking WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY feature ORDER BY count DESC`
    );
    res.json({ daily: daily.rows, by_feature: byFeature.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Admin API on port ${PORT}`));
