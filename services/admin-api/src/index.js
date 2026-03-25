// ============================================================
// VartMap Admin API - Complete Enterprise Backend
// ============================================================
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

// ─── AUTH MIDDLEWARE ───
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ─── HEALTH ───
app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW()');
    res.json({ status: 'healthy', service: 'admin-api', timestamp: r.rows[0].now, database: 'connected' });
  } catch (e) { res.status(500).json({ status: 'unhealthy', error: e.message }); }
});

// ─── AUTH ───
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await pool.query('SELECT * FROM admin_users WHERE email=$1 AND status=$2', [email, 'active']);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    await pool.query('UPDATE admin_users SET last_login_at=NOW() WHERE id=$1', [user.id]);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DASHBOARD ───
app.get('/api/v1/dashboard', auth, async (req, res) => {
  try {
    // Helper: run query safely, return 0 if table doesn't exist
    const safeCount = async (query) => {
      try {
        const r = await pool.query(query);
        return +(r.rows[0].count || r.rows[0].total || 0);
      } catch (e) { return 0; }
    };

    const [
      total_farmers,
      conversations_24h,
      active_farmers_24h,
      total_templates,
      active_campaigns,
      moderation_pending,
      total_rewards_points,
      total_orders,
      active_schemes,
      active_spin_wheels,
      open_chats
    ] = await Promise.all([
      safeCount('SELECT COUNT(*) FROM farmers'),
      safeCount("SELECT COUNT(*) FROM conversations WHERE created_at > NOW() - INTERVAL '24 hours'"),
      safeCount("SELECT COUNT(DISTINCT farmer_id) FROM conversations WHERE created_at > NOW() - INTERVAL '24 hours'"),
      safeCount('SELECT COUNT(*) FROM message_templates'),
      safeCount("SELECT COUNT(*) FROM campaigns WHERE status='active'"),
      safeCount("SELECT COUNT(*) FROM moderation_queue WHERE status='pending'"),
      safeCount('SELECT COALESCE(SUM(points),0) as total FROM rewards'),
      safeCount('SELECT COUNT(*) FROM orders'),
      safeCount("SELECT COUNT(*) FROM government_schemes WHERE status='active'"),
      safeCount("SELECT COUNT(*) FROM spin_wheels WHERE status='active'"),
      safeCount("SELECT COUNT(*) FROM wa_chat_sessions WHERE status IN ('open','active','assigned')")
    ]);

    res.json({
      total_farmers,
      conversations_24h,
      active_farmers_24h,
      total_templates,
      active_campaigns,
      moderation_pending,
      total_rewards_points,
      total_orders,
      active_schemes,
      active_spin_wheels,
      open_chats
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── FARMERS (Full CRUD) ───
app.get('/api/v1/farmers', auth, async (req, res) => {
  try {
    const { search, status, district, crop, limit = 50, offset = 0 } = req.query;
    let q = 'SELECT f.*, d.district_name, d.state_name FROM farmers f LEFT JOIN districts_master d ON f.district_id=d.id WHERE 1=1';
    const p = [];
    if (search) { p.push('%' + search + '%'); q += ` AND (f.name ILIKE $${p.length} OR f.phone ILIKE $${p.length} OR f.village ILIKE $${p.length})`; }
    if (status) { p.push(status); q += ` AND f.status=$${p.length}`; }
    if (district) { p.push('%' + district + '%'); q += ` AND d.district_name ILIKE $${p.length}`; }
    if (crop) { p.push('%' + crop + '%'); q += ` AND f.crops::text ILIKE $${p.length}`; }
    q += ' ORDER BY f.created_at DESC';
    p.push(+limit); q += ` LIMIT $${p.length}`;
    p.push(+offset); q += ` OFFSET $${p.length}`;
    const result = await pool.query(q, p);
    const total = await pool.query('SELECT COUNT(*) FROM farmers');
    res.json({ farmers: result.rows, total: +total.rows[0].count, limit: +limit, offset: +offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/farmers/:id', auth, async (req, res) => {
  try {
    const f = await pool.query('SELECT f.*, d.district_name, d.state_name FROM farmers f LEFT JOIN districts_master d ON f.district_id=d.id WHERE f.id=$1', [req.params.id]);
    if (!f.rows.length) return res.status(404).json({ error: 'Farmer not found' });
    const [conv, loyalty, spins, soil] = await Promise.all([
      pool.query('SELECT * FROM conversations WHERE farmer_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]),
      pool.query('SELECT * FROM farmer_loyalty WHERE farmer_id=$1', [req.params.id]),
      pool.query('SELECT sr.*, sw.name as wheel_name FROM spin_results sr JOIN spin_wheels sw ON sr.wheel_id=sw.id WHERE sr.farmer_id=$1 ORDER BY sr.created_at DESC', [req.params.id]),
      pool.query('SELECT * FROM soil_health_cards WHERE farmer_id=$1 ORDER BY sample_date DESC', [req.params.id])
    ]);
    res.json({ farmer: f.rows[0], conversations: conv.rows, loyalty: loyalty.rows[0] || null, spin_history: spins.rows, soil_cards: soil.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/farmers', auth, async (req, res) => {
  try {
    const {
      name, phone, village, district_id, language, status,
      pin_code, land_holding_acres, crops, soil_type,
      irrigation_type, farming_type
    } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Clean phone - digits only
    const cleanPhone = phone.replace(/[^0-9]/g, '');

    // Check if phone already exists
    const existing = await pool.query('SELECT id FROM farmers WHERE phone = $1', [cleanPhone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Farmer with this phone number already exists' });
    }

    // Generate referral code
    const refCode = 'VRT' + cleanPhone.slice(-6) + Math.random().toString(36).substring(2, 5).toUpperCase();

    const result = await pool.query(
      `INSERT INTO farmers (
        id, phone, name, language, district_id, village, pin_code,
        land_holding_acres, crops, soil_type, irrigation_type, farming_type,
        onboarding_stage, profile_complete, status, referral_code,
        total_interactions, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        'registered', false, $12, $13,
        0, NOW(), NOW()
      ) RETURNING *`,
      [
        cleanPhone,
        name || null,
        language || 'hi',
        district_id || null,
        village || null,
        pin_code || null,
        land_holding_acres || null,
        crops ? (Array.isArray(crops) ? crops : [crops]) : null,
        soil_type || null,
        irrigation_type || null,
        farming_type || null,
        status || 'active',
        refCode
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create farmer error:', err);
    res.status(500).json({ error: err.message });
  }
});


app.put('/api/v1/farmers/:id', auth, async (req, res) => {
  try {
    const fields = ['name', 'phone', 'language', 'district_id', 'village', 'pin_code', 'land_holding_acres', 'crops', 'soil_type', 'irrigation_type', 'farming_type', 'status'];
    const sets = []; const vals = [];
    fields.forEach(f => { if (req.body[f] !== undefined) { vals.push(req.body[f]); sets.push(`${f}=$${vals.length}`); } });
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    const r = await pool.query(`UPDATE farmers SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    res.json({ farmer: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WHATSAPP CHAT (Full CRM) ───
app.get('/api/v1/chats', auth, async (req, res) => {
  try {
    const { status, priority, search, limit = 50, offset = 0 } = req.query;
    let q = `SELECT cs.*, f.name as farmer_name, f.phone as farmer_phone, f.village, a.name as assigned_name
             FROM wa_chat_sessions cs
             JOIN farmers f ON cs.farmer_id=f.id
             LEFT JOIN admin_users a ON cs.admin_id=a.id WHERE 1=1`;
    const p = [];
    if (status) { p.push(status); q += ` AND cs.status=$${p.length}`; }
    if (priority) { p.push(priority); q += ` AND cs.priority=$${p.length}`; }
    if (search) { p.push('%' + search + '%'); q += ` AND (f.name ILIKE $${p.length} OR f.phone ILIKE $${p.length})`; }
    q += ' ORDER BY cs.last_message_at DESC';
    p.push(+limit); q += ` LIMIT $${p.length}`;
    p.push(+offset); q += ` OFFSET $${p.length}`;
    const r = await pool.query(q, p);
    const total = await pool.query("SELECT COUNT(*) FROM wa_chat_sessions");
    res.json({ chats: r.rows, total: +total.rows[0].count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/chats/:id/messages', auth, async (req, res) => {
  try {
    const { limit = 100, before } = req.query;
    let q = 'SELECT m.*, f.name as farmer_name, a.name as admin_name FROM wa_messages m LEFT JOIN farmers f ON m.farmer_id=f.id LEFT JOIN admin_users a ON m.sender_id=a.id WHERE m.session_id=$1';
    const p = [req.params.id];
    if (before) { p.push(before); q += ` AND m.created_at < $${p.length}`; }
    q += ' ORDER BY m.created_at DESC';
    p.push(+limit); q += ` LIMIT $${p.length}`;
    const r = await pool.query(q, p);
    await pool.query('UPDATE wa_chat_sessions SET unread_count=0 WHERE id=$1', [req.params.id]);
    res.json({ messages: r.rows.reverse() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/chats/:id/send', auth, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { content } = req.body;

    if (!content) return res.status(400).json({ error: 'content is required' });

    const session = await pool.query(
      `SELECT s.*, f.phone, f.name as farmer_name, f.id as farmer_id
       FROM wa_chat_sessions s
       JOIN farmers f ON s.farmer_id = f.id
       WHERE s.id = $1`,
      [sessionId]
    );

    if (!session.rows.length) return res.status(404).json({ error: 'Chat session not found' });

    const farmerPhone = session.rows[0].phone;
    const farmerId = session.rows[0].farmer_id;

    const msg = await pool.query(
      `INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, sender_id, message_type, content, wa_status, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'outbound', 'admin', $3, 'text', $4, 'sending', NOW())
       RETURNING *`,
      [sessionId, farmerId, req.user.id, content]
    );

    await pool.query(
      'UPDATE wa_chat_sessions SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1',
      [sessionId]
    );

    const gatewayUrl = process.env.GATEWAY_URL || 'https://vartmap-whatsapp-gateway.onrender.com';
    try {
      await axios.post(`${gatewayUrl}/api/v1/send-message`, {
        phone: farmerPhone,
        message: content,
        session_id: sessionId,
        farmer_id: farmerId
      });

      await pool.query("UPDATE wa_messages SET wa_status = 'sent' WHERE id = $1", [msg.rows[0].id]);
      res.json({ success: true, message: msg.rows[0], wa_delivered: true });
    } catch (waErr) {
      console.error('WhatsApp send failed:', waErr.response?.data || waErr.message);
      await pool.query("UPDATE wa_messages SET wa_status = 'failed' WHERE id = $1", [msg.rows[0].id]);
      res.json({ success: true, message: msg.rows[0], wa_delivered: false, wa_error: waErr.message });
    }
  } catch (err) {
    console.error('Chat send error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/v1/chats/:id/assign', auth, async (req, res) => {
  try {
    const { admin_id, status } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (admin_id) {
      updates.push(`admin_id = $${idx++}`);
      values.push(admin_id);
    }
    if (status) {
      updates.push(`status = $${idx++}`);
      values.push(status);
    }
    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE wa_chat_sessions SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Assign chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/chats/start', auth, async (req, res) => {
  try {
    const { farmer_id } = req.body;
    if (!farmer_id) return res.status(400).json({ error: 'farmer_id required' });

    // Check for existing active/assigned session
    const existing = await pool.query(
      "SELECT * FROM wa_chat_sessions WHERE farmer_id = $1 AND status IN ('active', 'assigned') ORDER BY created_at DESC LIMIT 1",
      [farmer_id]
    );

    if (existing.rows.length > 0) {
      return res.json({ session: existing.rows[0], existing: true });
    }

    const result = await pool.query(
      `INSERT INTO wa_chat_sessions (id, farmer_id, admin_id, status, last_message_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'active', NOW(), NOW(), NOW())
       RETURNING *`,
      [farmer_id, req.user.id]
    );

    res.json({ session: result.rows[0], existing: false });
  } catch (err) {
    console.error('Start chat error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── TEMPLATES (Full CRUD) ───
app.get('/api/v1/templates', auth, async (req, res) => {
  try {
    const { category, language, status } = req.query;
    let q = 'SELECT * FROM message_templates WHERE 1=1';
    const p = [];
    if (category) { p.push(category); q += ` AND category=$${p.length}`; }
    if (language) { p.push(language); q += ` AND language=$${p.length}`; }
    if (status) { p.push(status); q += ` AND status=$${p.length}`; }
    q += ' ORDER BY created_at DESC';
    const r = await pool.query(q, p);
    res.json({ templates: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/templates', auth, async (req, res) => {
  try {
    const { name, language, category, template_text, variables, wa_template_name } = req.body;
    const r = await pool.query(
      `INSERT INTO message_templates (name, language, category, template_text, variables, wa_template_name, status) VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING *`,
      [name, language || 'hi', category, template_text, variables || '{}', wa_template_name]
    );
    res.json({ template: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v1/templates/:id', auth, async (req, res) => {
  try {
    const { name, language, category, template_text, variables, wa_template_name, status } = req.body;
    const r = await pool.query(
      `UPDATE message_templates SET name=COALESCE($1,name), language=COALESCE($2,language), category=COALESCE($3,category),
       template_text=COALESCE($4,template_text), variables=COALESCE($5,variables), wa_template_name=COALESCE($6,wa_template_name),
       status=COALESCE($7,status) WHERE id=$8 RETURNING *`,
      [name, language, category, template_text, variables, wa_template_name, status, req.params.id]
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

// ─── CAMPAIGNS ───
app.get('/api/v1/campaigns', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT c.*, t.name as template_name FROM campaigns c LEFT JOIN message_templates t ON c.template_id=t.id ORDER BY c.created_at DESC');
    res.json({ campaigns: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/campaigns', auth, async (req, res) => {
  try {
    const { name, template_id, target_criteria, scheduled_at } = req.body;
    let targetCount = 0;
    if (target_criteria) {
      let cq = 'SELECT COUNT(*) FROM farmers WHERE status=\'active\'';
      if (target_criteria.district) cq += ` AND district_id IN (SELECT id FROM districts_master WHERE district_name ILIKE '%${target_criteria.district}%')`;
      if (target_criteria.crop) cq += ` AND crops::text ILIKE '%${target_criteria.crop}%'`;
      if (target_criteria.language) cq += ` AND language='${target_criteria.language}'`;
      const tc = await pool.query(cq);
      targetCount = +tc.rows[0].count;
    }
    const r = await pool.query(
      `INSERT INTO campaigns (name, template_id, target_criteria, target_count, scheduled_at, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING *`,
      [name, template_id, JSON.stringify(target_criteria || {}), targetCount, scheduled_at, req.user.id]
    );
    res.json({ campaign: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v1/campaigns/:id', auth, async (req, res) => {
  try {
    const { name, template_id, target_criteria, status, scheduled_at } = req.body;
    const r = await pool.query(
      `UPDATE campaigns SET name=COALESCE($1,name), template_id=COALESCE($2,template_id),
       target_criteria=COALESCE($3,target_criteria), status=COALESCE($4,status),
       scheduled_at=COALESCE($5,scheduled_at) WHERE id=$6 RETURNING *`,
      [name, template_id, target_criteria ? JSON.stringify(target_criteria) : null, status, scheduled_at, req.params.id]
    );
    res.json({ campaign: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─── SPIN WHEELS (Digicides-style) ───
app.get('/api/v1/spin-wheels', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM spin_wheels ORDER BY created_at DESC');
    for (let w of r.rows) {
      const segs = await pool.query('SELECT * FROM spin_wheel_segments WHERE wheel_id=$1 ORDER BY sort_order', [w.id]);
      w.segments = segs.rows;
      const stats = await pool.query('SELECT COUNT(*) as total_spins, COUNT(CASE WHEN status!=\'better_luck\' THEN 1 END) as winners FROM spin_results WHERE wheel_id=$1', [w.id]);
      w.stats = stats.rows[0];
    }
    res.json({ wheels: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/spin-wheels', auth, async (req, res) => {
  try {
    const { name, description, type, start_date, end_date, max_spins_per_farmer, total_budget, segments } = req.body;
    const w = await pool.query(
      `INSERT INTO spin_wheels (name, description, type, start_date, end_date, max_spins_per_farmer, total_budget, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING *`,
      [name, description, type || 'spin_wheel', start_date, end_date, max_spins_per_farmer || 1, total_budget || 0, req.user.id]
    );
    if (segments && segments.length) {
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        await pool.query(
          `INSERT INTO spin_wheel_segments (wheel_id, label, prize_type, prize_value, prize_description, color, probability, max_winners, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [w.rows[0].id, s.label, s.prize_type, s.prize_value || 0, s.prize_description, s.color || '#4CAF50', s.probability, s.max_winners || 0, i]
        );
      }
    }
    res.json({ wheel: w.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v1/spin-wheels/:id', auth, async (req, res) => {
  try {
    const { name, description, status, start_date, end_date, max_spins_per_farmer, total_budget } = req.body;
    const r = await pool.query(
      `UPDATE spin_wheels SET name=COALESCE($1,name), description=COALESCE($2,description), status=COALESCE($3,status),
       start_date=COALESCE($4,start_date), end_date=COALESCE($5,end_date),
       max_spins_per_farmer=COALESCE($6,max_spins_per_farmer), total_budget=COALESCE($7,total_budget) WHERE id=$8 RETURNING *`,
      [name, description, status, start_date, end_date, max_spins_per_farmer, total_budget, req.params.id]
    );
    res.json({ wheel: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/spin-wheels/:id/results', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sr.*, f.name as farmer_name, f.phone as farmer_phone FROM spin_results sr
       JOIN farmers f ON sr.farmer_id=f.id WHERE sr.wheel_id=$1 ORDER BY sr.created_at DESC`,
      [req.params.id]
    );
    res.json({ results: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── LOYALTY SYSTEM ───
app.get('/api/v1/loyalty/programs', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM loyalty_programs ORDER BY created_at DESC');
    for (let p of r.rows) {
      const stats = await pool.query('SELECT COUNT(*) as members, COALESCE(SUM(available_points),0) as total_available FROM farmer_loyalty WHERE program_id=$1', [p.id]);
      p.stats = stats.rows[0];
    }
    res.json({ programs: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/loyalty/programs', auth, async (req, res) => {
  try {
    const { name, description, points_per_purchase, points_per_referral, points_per_interaction, min_redeem_points, point_value_inr, tiers } = req.body;
    const r = await pool.query(
      `INSERT INTO loyalty_programs (name, description, points_per_purchase, points_per_referral, points_per_interaction, min_redeem_points, point_value_inr, tiers)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, description, points_per_purchase || 1, points_per_referral || 10, points_per_interaction || 0.5, min_redeem_points || 100, point_value_inr || 0.10, JSON.stringify(tiers || [])]
    );
    res.json({ program: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/loyalty/leaderboard', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT fl.*, f.name, f.phone, f.village FROM farmer_loyalty fl
       JOIN farmers f ON fl.farmer_id=f.id ORDER BY fl.lifetime_points DESC LIMIT 50`
    );
    res.json({ leaderboard: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/loyalty/award', auth, async (req, res) => {
  try {
    const { farmer_id, points, source, description } = req.body;
    const existing = await pool.query('SELECT * FROM farmer_loyalty WHERE farmer_id=$1', [farmer_id]);
    let fl;
    if (existing.rows.length) {
      fl = await pool.query(
        `UPDATE farmer_loyalty SET total_points=total_points+$1, available_points=available_points+$1, lifetime_points=lifetime_points+$1 WHERE farmer_id=$2 RETURNING *`,
        [points, farmer_id]
      );
    } else {
      fl = await pool.query(
        `INSERT INTO farmer_loyalty (farmer_id, total_points, available_points, lifetime_points) VALUES ($1,$2,$2,$2) RETURNING *`,
        [farmer_id, points]
      );
    }
    await pool.query(
      `INSERT INTO loyalty_transactions (farmer_id, type, points, balance_after, source, description)
       VALUES ($1,'earn',$2,$3,$4,$5)`,
      [farmer_id, points, fl.rows[0].available_points, source || 'manual', description || 'Admin award']
    );
    res.json({ loyalty: fl.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── COUPON CODES ───
app.get('/api/v1/coupons', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM coupon_campaigns ORDER BY created_at DESC');
    for (let c of r.rows) {
      const stats = await pool.query('SELECT COUNT(*) as total_codes, COUNT(CASE WHEN status=\'used\' THEN 1 END) as used FROM coupon_codes WHERE campaign_id=$1', [c.id]);
      c.stats = stats.rows[0];
    }
    res.json({ campaigns: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/coupons', auth, async (req, res) => {
  try {
    const { name, code_prefix, discount_type, discount_value, max_uses, min_purchase, start_date, end_date, generate_count } = req.body;
    const camp = await pool.query(
      `INSERT INTO coupon_campaigns (name, code_prefix, discount_type, discount_value, max_uses, min_purchase, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, code_prefix || 'VART', discount_type || 'percentage', discount_value, max_uses || 0, min_purchase || 0, start_date, end_date]
    );
    const codes = [];
    const count = generate_count || 10;
    for (let i = 0; i < count; i++) {
      const code = (code_prefix || 'VART') + crypto.randomBytes(4).toString('hex').toUpperCase();
      await pool.query('INSERT INTO coupon_codes (campaign_id, code) VALUES ($1,$2)', [camp.rows[0].id, code]);
      codes.push(code);
    }
    res.json({ campaign: camp.rows[0], codes_generated: count, sample_codes: codes.slice(0, 5) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SOIL NUTRIENT DATA ───
app.get('/api/v1/soil-data', auth, async (req, res) => {
  try {
    const { state, district, block, village, soil_type } = req.query;
    let q = 'SELECT * FROM soil_nutrient_data WHERE 1=1';
    const p = [];
    if (state) { p.push('%' + state + '%'); q += ` AND state_name ILIKE $${p.length}`; }
    if (district) { p.push('%' + district + '%'); q += ` AND district_name ILIKE $${p.length}`; }
    if (block) { p.push('%' + block + '%'); q += ` AND block_name ILIKE $${p.length}`; }
    if (village) { p.push('%' + village + '%'); q += ` AND village_name ILIKE $${p.length}`; }
    if (soil_type) { p.push('%' + soil_type + '%'); q += ` AND soil_type ILIKE $${p.length}`; }
    q += ' ORDER BY state_name, district_name, block_name LIMIT 200';
    const r = await pool.query(q, p);
    res.json({ data: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/soil-data', auth, async (req, res) => {
  try {
    const d = req.body;
    const r = await pool.query(
      `INSERT INTO soil_nutrient_data (state_name, state_code, district_name, block_name, village_name, sample_year, total_samples,
       nitrogen_low_pct, nitrogen_medium_pct, nitrogen_high_pct,
       phosphorus_low_pct, phosphorus_medium_pct, phosphorus_high_pct,
       potassium_low_pct, potassium_medium_pct, potassium_high_pct,
       organic_carbon_low_pct, organic_carbon_medium_pct, organic_carbon_high_pct,
       avg_ph, avg_ec, avg_sulphur, avg_zinc, avg_boron, avg_iron, avg_manganese, avg_copper,
       soil_type, recommendations, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) RETURNING *`,
      [d.state_name, d.state_code, d.district_name, d.block_name, d.village_name, d.sample_year, d.total_samples || 0,
       d.nitrogen_low_pct || 0, d.nitrogen_medium_pct || 0, d.nitrogen_high_pct || 0,
       d.phosphorus_low_pct || 0, d.phosphorus_medium_pct || 0, d.phosphorus_high_pct || 0,
       d.potassium_low_pct || 0, d.potassium_medium_pct || 0, d.potassium_high_pct || 0,
       d.organic_carbon_low_pct || 0, d.organic_carbon_medium_pct || 0, d.organic_carbon_high_pct || 0,
       d.avg_ph, d.avg_ec, d.avg_sulphur, d.avg_zinc, d.avg_boron, d.avg_iron, d.avg_manganese, d.avg_copper,
       d.soil_type, JSON.stringify(d.recommendations || {}), d.source || 'manual']
    );
    res.json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/soil-data/bulk', auth, async (req, res) => {
  try {
    const { records } = req.body;
    let inserted = 0;
    for (const d of records) {
      await pool.query(
        `INSERT INTO soil_nutrient_data (state_name, state_code, district_name, block_name, village_name, sample_year, total_samples,
         nitrogen_low_pct, nitrogen_medium_pct, nitrogen_high_pct,
         phosphorus_low_pct, phosphorus_medium_pct, phosphorus_high_pct,
         potassium_low_pct, potassium_medium_pct, potassium_high_pct,
         organic_carbon_low_pct, organic_carbon_medium_pct, organic_carbon_high_pct,
         avg_ph, soil_type, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [d.state_name, d.state_code, d.district_name, d.block_name, d.village_name, d.sample_year, d.total_samples || 0,
         d.nitrogen_low_pct || 0, d.nitrogen_medium_pct || 0, d.nitrogen_high_pct || 0,
         d.phosphorus_low_pct || 0, d.phosphorus_medium_pct || 0, d.phosphorus_high_pct || 0,
         d.potassium_low_pct || 0, d.potassium_medium_pct || 0, d.potassium_high_pct || 0,
         d.organic_carbon_low_pct || 0, d.organic_carbon_medium_pct || 0, d.organic_carbon_high_pct || 0,
         d.avg_ph, d.soil_type, 'bulk_upload']
      );
      inserted++;
    }
    res.json({ inserted, total: records.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/soil-data/summary', auth, async (req, res) => {
  try {
    const states = await pool.query('SELECT DISTINCT state_name, COUNT(*) as records FROM soil_nutrient_data GROUP BY state_name ORDER BY state_name');
    const districts = await pool.query('SELECT DISTINCT district_name, state_name, COUNT(*) as records FROM soil_nutrient_data GROUP BY district_name, state_name ORDER BY state_name, district_name');
    const total = await pool.query('SELECT COUNT(*) FROM soil_nutrient_data');
    res.json({ total: +total.rows[0].count, states: states.rows, districts: districts.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REWARDS (Points-based) ───
app.get('/api/v1/rewards', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT r.*, f.name as farmer_name, f.phone FROM rewards r LEFT JOIN farmers f ON r.farmer_id=f.id ORDER BY r.created_at DESC LIMIT 100');
    const stats = await pool.query("SELECT COUNT(*) as total, COALESCE(SUM(points),0) as total_points, COUNT(CASE WHEN status='earned' THEN 1 END) as pending FROM rewards");
    res.json({ rewards: r.rows, stats: stats.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/rewards', auth, async (req, res) => {
  try {
    const { farmer_id, type, points, description } = req.body;
    const r = await pool.query(
      `INSERT INTO rewards (farmer_id, type, points, description, status) VALUES ($1,$2,$3,$4,'earned') RETURNING *`,
      [farmer_id, type || 'bonus', points, description]
    );
    res.json({ reward: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REFERRALS ───
app.get('/api/v1/referrals', auth, async (req, res) => {
  try {
    const codes = await pool.query('SELECT rc.*, f.name as farmer_name, f.phone FROM referral_codes rc LEFT JOIN farmers f ON rc.farmer_id=f.id ORDER BY rc.created_at DESC');
    const refs = await pool.query('SELECT r.*, f1.name as referrer_name, f2.name as referee_name FROM referrals r LEFT JOIN farmers f1 ON r.referrer_id=f1.id LEFT JOIN farmers f2 ON r.referee_id=f2.id ORDER BY r.created_at DESC LIMIT 100');
    res.json({ codes: codes.rows, referrals: refs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GOVERNMENT SCHEMES ───
app.get('/api/v1/schemes', auth, async (req, res) => {
  try {
    const { status, level, state } = req.query;
    let q = 'SELECT * FROM government_schemes WHERE 1=1';
    const p = [];
    if (status) { p.push(status); q += ` AND status=$${p.length}`; }
    if (level) { p.push(level); q += ` AND level=$${p.length}`; }
    if (state) { p.push(state); q += ` AND state_code=$${p.length}`; }
    q += ' ORDER BY created_at DESC';
    const r = await pool.query(q, p);
    res.json({ schemes: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/schemes', auth, async (req, res) => {
  try {
    const { name, name_hi, department, level, state_code, description, description_hi, eligibility, benefits, benefits_hi, application_url, helpline, deadline } = req.body;
    const r = await pool.query(
      `INSERT INTO government_schemes (name, name_hi, department, level, state_code, description, description_hi, eligibility, benefits, benefits_hi, application_url, helpline, deadline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [name, name_hi, department, level || 'central', state_code, description, description_hi, JSON.stringify(eligibility || {}), benefits, benefits_hi, application_url, helpline, deadline]
    );
    res.json({ scheme: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v1/schemes/:id', auth, async (req, res) => {
  try {
    const { name, name_hi, department, level, state_code, description, description_hi, eligibility, benefits, benefits_hi, application_url, helpline, deadline, status } = req.body;
    const r = await pool.query(
      `UPDATE government_schemes SET name=COALESCE($1,name), name_hi=COALESCE($2,name_hi), department=COALESCE($3,department),
       level=COALESCE($4,level), state_code=COALESCE($5,state_code), description=COALESCE($6,description),
       description_hi=COALESCE($7,description_hi), benefits=COALESCE($8,benefits), benefits_hi=COALESCE($9,benefits_hi),
       application_url=COALESCE($10,application_url), helpline=COALESCE($11,helpline), deadline=COALESCE($12,deadline),
       status=COALESCE($13,status) WHERE id=$14 RETURNING *`,
      [name, name_hi, department, level, state_code, description, description_hi, benefits, benefits_hi, application_url, helpline, deadline, status, req.params.id]
    );
    res.json({ scheme: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PRODUCTS ───
app.get('/api/v1/products', auth, async (req, res) => {
  try {
    const { search, category, brand } = req.query;
    let q = 'SELECT * FROM products WHERE 1=1';
    const p = [];
    if (search) { p.push('%' + search + '%'); q += ` AND (name ILIKE $${p.length} OR brand ILIKE $${p.length})`; }
    if (category) { p.push(category); q += ` AND category=$${p.length}`; }
    if (brand) { p.push(brand); q += ` AND brand=$${p.length}`; }
    q += ' ORDER BY created_at DESC';
    const r = await pool.query(q, p);
    res.json({ products: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/products', auth, async (req, res) => {
  try {
    const { name, brand, category, subcategory, registration_number, active_ingredients, dosage, application_method, target_crops, target_pests, safety_info, image_url } = req.body;
    const r = await pool.query(
      `INSERT INTO products (name, brand, category, subcategory, registration_number, active_ingredients, dosage, application_method, target_crops, target_pests, safety_info, image_url, verified, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,'active') RETURNING *`,
      [name, brand, category, subcategory, registration_number, JSON.stringify(active_ingredients || {}), dosage, application_method, target_crops || '{}', target_pests || '{}', safety_info, image_url]
    );
    res.json({ product: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MANDI PRICES ───
app.get('/api/v1/mandi-prices', auth, async (req, res) => {
  try {
    const { commodity, market, state, date } = req.query;
    let q = 'SELECT * FROM mandi_prices WHERE 1=1';
    const p = [];
    if (commodity) { p.push('%' + commodity + '%'); q += ` AND commodity ILIKE $${p.length}`; }
    if (market) { p.push('%' + market + '%'); q += ` AND market_name ILIKE $${p.length}`; }
    if (state) { p.push('%' + state + '%'); q += ` AND state ILIKE $${p.length}`; }
    if (date) { p.push(date); q += ` AND price_date=$${p.length}`; }
    q += ' ORDER BY price_date DESC, commodity LIMIT 200';
    const r = await pool.query(q, p);
    res.json({ prices: r.rows, count: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/mandi-prices', auth, async (req, res) => {
  try {
    const { commodity, variety, market_name, district, state, min_price, max_price, modal_price, unit, price_date } = req.body;
    const r = await pool.query(
      `INSERT INTO mandi_prices (commodity, variety, market_name, district, state, min_price, max_price, modal_price, unit, price_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [commodity, variety, market_name, district, state, min_price, max_price, modal_price, unit || 'quintal', price_date]
    );
    res.json({ price: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MODERATION ───
app.get('/api/v1/moderation', auth, async (req, res) => {
  try {
    const { status } = req.query;
    let q = `SELECT mq.*, f.name as farmer_name, f.phone FROM moderation_queue mq
             LEFT JOIN farmers f ON mq.farmer_id=f.id WHERE 1=1`;
    const p = [];
    if (status) { p.push(status); q += ` AND mq.status=$${p.length}`; }
    q += ' ORDER BY mq.created_at DESC LIMIT 100';
    const r = await pool.query(q, p);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/moderation/:id/action', auth, async (req, res) => {
  try {
    const { action, reason } = req.body;
    await pool.query('UPDATE moderation_queue SET status=$1 WHERE id=$2', [action === 'approve' ? 'approved' : 'rejected', req.params.id]);
    await pool.query(
      `INSERT INTO moderation_actions (queue_id, action, reason, action_by) VALUES ($1,$2,$3,$4)`,
      [req.params.id, action, reason, req.user.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ORDERS ───
app.get('/api/v1/orders', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.*, f.name as farmer_name, f.phone, d.name as dealer_name, p.name as product_name
       FROM orders o LEFT JOIN farmers f ON o.farmer_id=f.id LEFT JOIN dealers d ON o.dealer_id=d.id
       LEFT JOIN products p ON o.product_id=p.id ORDER BY o.created_at DESC LIMIT 100`
    );
    res.json({ orders: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DEALERS ───
app.get('/api/v1/dealers', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT d.*, dm.district_name FROM dealers d LEFT JOIN districts_master dm ON d.district_id=dm.id ORDER BY d.created_at DESC');
    res.json({ dealers: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/dealers', auth, async (req, res) => {
  try {
    const { name, phone, district_id, address, license_number } = req.body;
    const r = await pool.query(
      `INSERT INTO dealers (name, phone, district_id, address, license_number, verified, status) VALUES ($1,$2,$3,$4,$5,true,'active') RETURNING *`,
      [name, phone, district_id, address, license_number]
    );
    res.json({ dealer: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FIELD AGENTS ───
app.get('/api/v1/field-agents', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT fa.*, dm.district_name FROM field_agents fa LEFT JOIN districts_master dm ON fa.district_id=dm.id ORDER BY fa.created_at DESC');
    res.json({ agents: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/field-agents', auth, async (req, res) => {
  try {
    const { name, phone, email, district_id, area_villages, role } = req.body;
    const r = await pool.query(
      `INSERT INTO field_agents (name, phone, email, district_id, area_villages, role, status) VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING *`,
      [name, phone, email, district_id, area_villages || '{}', role || 'field_agent']
    );
    res.json({ agent: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NOTIFICATIONS LOG ───
app.get('/api/v1/notifications', auth, async (req, res) => {
  try {
    const { channel, type, status } = req.query;
    let q = 'SELECT nl.*, f.name as farmer_name FROM notification_logs nl LEFT JOIN farmers f ON nl.farmer_id=f.id WHERE 1=1';
    const p = [];
    if (channel) { p.push(channel); q += ` AND nl.channel=$${p.length}`; }
    if (type) { p.push(type); q += ` AND nl.type=$${p.length}`; }
    if (status) { p.push(status); q += ` AND nl.status=$${p.length}`; }
    q += ' ORDER BY nl.created_at DESC LIMIT 100';
    const r = await pool.query(q, p);
    res.json({ notifications: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ANALYTICS ───
app.get('/api/v1/analytics/overview', auth, async (req, res) => {
  try {
    const days = req.query.days || 30;
    const [daily, byIntent, byChannel, growth] = await Promise.all([
      pool.query(`SELECT DATE(created_at) as date, COUNT(*) as conversations, COUNT(DISTINCT farmer_id) as active_farmers
                  FROM conversations WHERE created_at > NOW() - INTERVAL '${+days} days' GROUP BY DATE(created_at) ORDER BY date`),
      pool.query(`SELECT intent, COUNT(*) as count FROM conversations WHERE intent IS NOT NULL AND created_at > NOW() - INTERVAL '${+days} days' GROUP BY intent ORDER BY count DESC LIMIT 10`),
      pool.query(`SELECT channel, COUNT(*) as count FROM conversations WHERE created_at > NOW() - INTERVAL '${+days} days' GROUP BY channel`),
      pool.query(`SELECT DATE(created_at) as date, COUNT(*) as new_farmers FROM farmers WHERE created_at > NOW() - INTERVAL '${+days} days' GROUP BY DATE(created_at) ORDER BY date`)
    ]);
    res.json({ daily: daily.rows, by_intent: byIntent.rows, by_channel: byChannel.rows, farmer_growth: growth.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/analytics/usage', auth, async (req, res) => {
  try {
    const [daily, byFeature, costs] = await Promise.all([
      pool.query("SELECT DATE(created_at) as date, COUNT(*) as count FROM usage_tracking WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date"),
      pool.query("SELECT feature, COUNT(*) as count, COALESCE(SUM(cost_inr),0) as total_cost FROM usage_tracking WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY feature ORDER BY count DESC"),
      pool.query("SELECT DATE(created_at) as date, COALESCE(SUM(cost_inr),0) as cost FROM usage_tracking WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY DATE(created_at) ORDER BY date")
    ]);
    res.json({ daily: daily.rows, by_feature: byFeature.rows, costs: costs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DISTRICTS ───
app.get('/api/v1/districts', auth, async (req, res) => {
  try {
    const { state } = req.query;
    let q = 'SELECT * FROM districts_master WHERE active=true';
    const p = [];
    if (state) { p.push('%' + state + '%'); q += ` AND state_name ILIKE $${p.length}`; }
    q += ' ORDER BY state_name, district_name';
    const r = await pool.query(q, p);
    res.json({ districts: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AUDIT LOG ───
app.get('/api/v1/audit-log', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100');
    res.json({ logs: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN USERS ───
app.get('/api/v1/admin-users', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, email, name, role, status, last_login_at, created_at FROM admin_users ORDER BY created_at');
    res.json({ users: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/admin-users', auth, async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      `INSERT INTO admin_users (email, password_hash, name, role, status) VALUES ($1,$2,$3,$4,'active') RETURNING id, email, name, role`,
      [email, hash, name, role || 'viewer']
    );
    res.json({ user: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─── PROXY: Fetch Live Data from Intelligence Service ───
const axios = require('axios');
const INTEL_URL = process.env.INTELLIGENCE_SERVICE_URL || 'https://vartmap-intelligence.onrender.com';

app.get('/api/v1/fetch-mandi-prices', auth, async (req, res) => {
  try {
    const { state, commodity, limit } = req.query;
    let url = INTEL_URL + '/api/v1/fetch-mandi-prices?limit=' + (limit || 100);
    if (state) url += '&state=' + encodeURIComponent(state);
    if (commodity) url += '&commodity=' + encodeURIComponent(commodity);
    const r = await axios.get(url, { timeout: 30000 });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/load-schemes', auth, async (req, res) => {
  try {
    const r = await axios.get(INTEL_URL + '/api/v1/load-schemes', { timeout: 30000 });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/load-soil-data', auth, async (req, res) => {
  try {
    const r = await axios.get(INTEL_URL + '/api/v1/load-soil-data', { timeout: 30000 });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Proxy: send WhatsApp message from admin dashboard chat
app.post('/api/v1/send-wa-message', auth, async (req, res) => {
  try {
    const { phone, message, session_id } = req.body;
    const gatewayUrl = process.env.GATEWAY_URL || 'https://vartmap-whatsapp-gateway.onrender.com';
    
    const response = await axios.post(`${gatewayUrl}/api/v1/send-message`, {
      phone, message, session_id
    });
    
    res.json(response.data);
  } catch (err) {
    console.error('Send WA message proxy error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});
// ─── PUBLIC SPIN WHEEL API (No auth required - Digicides-style flow) ───

// Get wheel info (public)
app.get('/api/v1/public/spin-wheel/:id', async (req, res) => {
  try {
    const w = await pool.query('SELECT id, name, description, status, max_spins_per_farmer, start_date, end_date FROM spin_wheels WHERE id=$1', [req.params.id]);
    if (!w.rows.length) return res.status(404).json({ error: 'Wheel not found' });
    
    const wheel = w.rows[0];
    if (wheel.status !== 'active') return res.status(410).json({ error: 'This campaign has ended' });
    if (new Date(wheel.end_date) < new Date()) return res.status(410).json({ error: 'This campaign has expired' });
    
    const segs = await pool.query(
      'SELECT id, label, prize_type, prize_value, color, probability FROM spin_wheel_segments WHERE wheel_id=$1 AND active=true ORDER BY sort_order',
      [req.params.id]
    );
    wheel.segments = segs.rows;
    res.json(wheel);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verify farmer + coupon (Step 1 of Digicides flow)
app.post('/api/v1/public/spin-wheel/:id/verify', async (req, res) => {
  try {
    const { name, phone, coupon_code, language } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    
    // Get wheel
    const w = await pool.query('SELECT * FROM spin_wheels WHERE id=$1 AND status=$2', [req.params.id, 'active']);
    if (!w.rows.length) return res.status(404).json({ error: 'Campaign not found or inactive' });
    const wheel = w.rows[0];
    
    // Find or create farmer
    let farmer = await pool.query('SELECT * FROM farmers WHERE phone=$1', [cleanPhone]);
    if (!farmer.rows.length) {
      farmer = await pool.query(
        `INSERT INTO farmers (id, name, phone, language, status, onboarding_stage, profile_complete, total_interactions, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'active', 'registered', false, 1, NOW(), NOW()) RETURNING *`,
        [name || 'Unknown', cleanPhone, language || 'hi']
      );
    } else {
      if (name) await pool.query('UPDATE farmers SET name=COALESCE(NULLIF($1,\'\'), name), updated_at=NOW() WHERE phone=$2', [name, cleanPhone]);
    }
    const farmerId = farmer.rows[0].id;
    
    // Verify coupon if provided
    if (coupon_code) {
      const coupon = await pool.query(
        "SELECT * FROM coupon_codes WHERE UPPER(code)=$1 AND status='active'",
        [coupon_code.toUpperCase()]
      );
      if (!coupon.rows.length) {
        // Allow spin without coupon for now (coupon is optional)
        // return res.status(400).json({ error: 'Invalid or already used coupon code' });
      } else {
        await pool.query("UPDATE coupon_codes SET status='used', used_by=$1, used_at=NOW() WHERE id=$2", [farmerId, coupon.rows[0].id]);
      }
    }
    
    // Check spin count
    const spinCount = await pool.query(
      'SELECT COUNT(*) FROM spin_results WHERE wheel_id=$1 AND farmer_id=$2',
      [req.params.id, farmerId]
    );
    const used = parseInt(spinCount.rows[0].count);
    const maxSpins = wheel.max_spins_per_farmer || 1;
    
    res.json({
      farmer_id: farmerId,
      farmer_name: farmer.rows[0].name,
      phone: cleanPhone,
      spins_used: used,
      spins_remaining: Math.max(0, maxSpins - used),
      max_spins: maxSpins
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Execute spin (server-side randomization - Digicides-style)
app.post('/api/v1/public/spin-wheel/:id/spin', async (req, res) => {
  try {
    const { farmer_id, phone } = req.body;
    if (!farmer_id) return res.status(400).json({ error: 'farmer_id is required' });
    
    // Get wheel
    const w = await pool.query('SELECT * FROM spin_wheels WHERE id=$1 AND status=$2', [req.params.id, 'active']);
    if (!w.rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const wheel = w.rows[0];
    
    // Check spins remaining
    const spinCount = await pool.query('SELECT COUNT(*) FROM spin_results WHERE wheel_id=$1 AND farmer_id=$2', [req.params.id, farmer_id]);
    if (parseInt(spinCount.rows[0].count) >= (wheel.max_spins_per_farmer || 1)) {
      return res.status(400).json({ error: 'No spins remaining' });
    }
    
    // Get segments
    const segs = await pool.query(
      'SELECT * FROM spin_wheel_segments WHERE wheel_id=$1 AND active=true ORDER BY sort_order',
      [req.params.id]
    );
    if (!segs.rows.length) return res.status(500).json({ error: 'No segments configured' });
    
    // Weighted random selection based on probability
    const segments = segs.rows;
    let totalProb = segments.reduce((sum, s) => sum + parseFloat(s.probability || 0), 0);
    let random = Math.random() * totalProb;
    let selectedSegment = segments[segments.length - 1]; // fallback
    
    for (const seg of segments) {
      random -= parseFloat(seg.probability || 0);
      if (random <= 0) {
        // Check max winners
        if (seg.max_winners > 0 && seg.current_winners >= seg.max_winners) {
          continue; // Skip if max winners reached, pick next
        }
        selectedSegment = seg;
        break;
      }
    }
    
    // Record result
    const refId = 'VRT-' + Date.now().toString(36).toUpperCase();
    await pool.query(
      `INSERT INTO spin_results (id, wheel_id, farmer_id, segment_id, prize_type, prize_value, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())`,
      [req.params.id, farmer_id, selectedSegment.id, selectedSegment.prize_type, selectedSegment.prize_value || 0,
       selectedSegment.prize_type === 'better_luck' ? 'no_prize' : 'won']
    );
    
    // Update winner count
    await pool.query(
      'UPDATE spin_wheel_segments SET current_winners = current_winners + 1 WHERE id=$1',
      [selectedSegment.id]
    );
    
    // Update budget spent
    if (selectedSegment.prize_type === 'cash' && selectedSegment.prize_value) {
      await pool.query(
        'UPDATE spin_wheels SET spent_budget = COALESCE(spent_budget, 0) + $1 WHERE id=$2',
        [selectedSegment.prize_value, req.params.id]
      );
    }
    
    // Award loyalty points if prize_type is 'points'
    if (selectedSegment.prize_type === 'points' && selectedSegment.prize_value) {
      const existing = await pool.query('SELECT * FROM farmer_loyalty WHERE farmer_id=$1', [farmer_id]);
      if (existing.rows.length) {
        await pool.query(
          'UPDATE farmer_loyalty SET total_points=total_points+$1, available_points=available_points+$1, lifetime_points=lifetime_points+$1 WHERE farmer_id=$2',
          [selectedSegment.prize_value, farmer_id]
        );
      } else {
        await pool.query(
          'INSERT INTO farmer_loyalty (farmer_id, total_points, available_points, lifetime_points) VALUES ($1,$2,$2,$2)',
          [farmer_id, selectedSegment.prize_value]
        );
      }
    }
    
    // Send WhatsApp notification
    if (phone && selectedSegment.prize_type !== 'better_luck') {
      try {
        const gatewayUrl = process.env.GATEWAY_URL || 'https://vartmap-whatsapp-gateway.onrender.com';
        const msg = `🎉 Congratulations! You won "${selectedSegment.label}" in the ${wheel.name} lucky draw!\n\nReference: ${refId}\nPrize will be credited within 24 hours.\n\n🌾 VartMap Krishi Sahayak`;
        await axios.post(`${gatewayUrl}/api/v1/send-message`, { phone, message: msg });
      } catch(e) { console.error('WhatsApp notification failed:', e.message); }
    }
    
    res.json({
      segment_id: selectedSegment.id,
      label: selectedSegment.label,
      prize_type: selectedSegment.prize_type,
      prize_value: selectedSegment.prize_value,
      color: selectedSegment.color,
      reference_id: refId
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── START SERVER ───
app.listen(PORT, () => console.log(`VartMap Admin API running on port ${PORT}`));
