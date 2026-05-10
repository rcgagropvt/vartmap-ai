// VartMap Admin API Routes Module
const bcrypt = require('bcryptjs');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const QRCode = require('qrcode');
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

function uploadToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'auto', folder: 'vartmap', ...options },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}
const XLSX = require('xlsx');

module.exports = function setupAdminAPI(app, pool) {







  
  
  
  
  // ---
  const auth = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  };

  // Community auth - accepts both admin and farmer tokens
  const communityAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    const token = authHeader.replace('Bearer ', '');
    // Try admin token first
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.farmer = { id: decoded.id || decoded.userId, phone: 'admin' };
      req.isAdmin = true;
      return next();
    } catch(e) {}
    // Try farmer token
    try {
      const decoded = jwt.verify(token, 'vartmap-farmer-secret-2024');
      req.farmer = decoded;
      req.isAdmin = false;
      return next();
    } catch(e) {}
    // Try farmer token with env secret
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.role === 'farmer') {
        req.farmer = decoded;
        req.isAdmin = false;
        return next();
      }
    } catch(e) {}
    res.status(403).json({ error: 'Invalid token' });
  };

  
  // ---
  app.get('/health', async (req, res) => {
    try {
      const r = await pool.query('SELECT NOW()');
      res.json({ status: 'healthy', service: 'admin-api', timestamp: r.rows[0].now, database: 'connected' });
    } catch (e) { res.status(500).json({ status: 'unhealthy', error: e.message }); }
  });
  
  // ---
  // === AUDIT LOG HELPER ===
  async function auditLog(eventType, entityType, entityId, action, actor, severity, metadata) {
    try {
      await pool.query(
        `INSERT INTO audit_log (event_id, event_type, entity_type, entity_id, action, actor_type, actor_id, severity, metadata, service, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'admin-api', NOW())`,
        [eventType, entityType, entityId || null, action, actor?.type || 'admin', actor?.id || 'system', severity || 'info', metadata ? JSON.stringify(metadata) : null]
      );
    } catch (e) { console.error('Audit log error:', e.message); }
  }
  app.post('/api/v1/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const r = await pool.query('SELECT * FROM admin_users WHERE email=$1 AND status=$2', [email, 'active']);
      if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
      const user = r.rows[0];
      if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
      await pool.query('UPDATE admin_users SET last_login_at=NOW() WHERE id=$1', [user.id]);
            await auditLog('auth.login', 'admin', null, 'Admin login', {type:'admin',id:email}, 'info', {email});
      res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
  app.get('/api/v1/dashboard', auth, async (req, res) => {
    try {
      const safeCount = async (query) => {
        try { const r = await pool.query(query); return +(r.rows[0].count || r.rows[0].total || r.rows[0].sum || 0); } catch (e) { return 0; }
      };
      const safeRows = async (query) => {
        try { const r = await pool.query(query); return r.rows; } catch (e) { return []; }
      };

      const [total_farmers, conversations_24h, active_farmers_24h, total_templates, active_campaigns, moderation_pending, total_rewards_points, total_orders, active_schemes, active_spin_wheels, open_chats, total_messages_24h, total_campaigns, total_messages_sent, total_delivered, total_read, total_failed] = await Promise.all([
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
        safeCount("SELECT COUNT(*) FROM wa_chat_sessions WHERE status IN ('open','active','assigned')"),
        safeCount("SELECT COUNT(*) FROM wa_messages WHERE created_at > NOW() - INTERVAL '24 hours'"),
        safeCount('SELECT COUNT(*) FROM campaigns'),
        safeCount('SELECT COALESCE(SUM(sent_count),0) as total FROM campaigns'),
        safeCount('SELECT COALESCE(SUM(delivered_count),0) as total FROM campaigns'),
        safeCount('SELECT COALESCE(SUM(read_count),0) as total FROM campaigns'),
        safeCount("SELECT COUNT(*) FROM campaign_messages WHERE status='failed'")
      ]);

      const [farmer_growth_7d, message_volume_7d, top_crops, top_districts, recent_campaigns, recent_farmers, hourly_activity, farmer_languages, campaign_performance, ai_usage_cost] = await Promise.all([
        safeRows("SELECT DATE(created_at) as date, COUNT(*) as count FROM farmers WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY DATE(created_at) ORDER BY date"),
        safeRows("SELECT DATE(created_at) as date, COUNT(*) FILTER (WHERE direction='inbound') as inbound, COUNT(*) FILTER (WHERE direction='outbound') as outbound FROM wa_messages WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY DATE(created_at) ORDER BY date"),
        safeRows("SELECT UNNEST(string_to_array(COALESCE(crops::text,'unknown'),',')) as crop, COUNT(DISTINCT id) as count FROM farmers WHERE status='active' GROUP BY crop ORDER BY count DESC LIMIT 8"),
        safeRows("SELECT COALESCE(d.district_name,'Unknown') as district, COALESCE(d.state_name,'') as state, COUNT(f.id) as count FROM farmers f LEFT JOIN districts_master d ON f.district_id=d.id WHERE f.status='active' GROUP BY d.district_name, d.state_name ORDER BY count DESC LIMIT 8"),
        safeRows("SELECT c.id, c.name, c.status, c.sent_count, c.delivered_count, c.read_count, c.created_at, t.name as template_name FROM campaigns c LEFT JOIN message_templates t ON c.template_id=t.id ORDER BY c.created_at DESC LIMIT 5"),
        safeRows("SELECT id, name, phone, village, crops, created_at FROM farmers ORDER BY created_at DESC LIMIT 5"),
        safeRows("SELECT EXTRACT(HOUR FROM created_at)::int as hour, COUNT(*) as count FROM wa_messages WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY hour ORDER BY hour"),
        safeRows("SELECT COALESCE(language,'unknown') as language, COUNT(*) as count FROM farmers WHERE status='active' GROUP BY language ORDER BY count DESC LIMIT 6"),
        safeRows("SELECT c.name, c.sent_count, c.delivered_count, c.read_count, CASE WHEN c.sent_count>0 THEN ROUND(c.delivered_count::numeric/c.sent_count*100,1) ELSE 0 END as delivery_rate, CASE WHEN c.delivered_count>0 THEN ROUND(c.read_count::numeric/c.delivered_count*100,1) ELSE 0 END as read_rate FROM campaigns c WHERE c.sent_count > 0 ORDER BY c.created_at DESC LIMIT 5"),
        safeRows("SELECT COALESCE(SUM(cost_inr),0) as total_cost, COUNT(*) as total_requests FROM usage_tracking WHERE created_at > NOW() - INTERVAL '30 days'")
      ]);

      res.json({
        total_farmers, conversations_24h, active_farmers_24h, total_templates, active_campaigns, moderation_pending, total_rewards_points, total_orders, active_schemes, active_spin_wheels, open_chats, total_messages_24h, total_campaigns, total_messages_sent, total_delivered, total_read, total_failed,
        farmer_growth_7d, message_volume_7d, top_crops, top_districts, recent_campaigns, recent_farmers, hourly_activity, farmer_languages, campaign_performance,
        ai_cost_30d: ai_usage_cost.length ? parseFloat(ai_usage_cost[0].total_cost) : 0,
        ai_requests_30d: ai_usage_cost.length ? parseInt(ai_usage_cost[0].total_requests) : 0
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  
  // ---
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
      const fields = ['name', 'phone', 'language', 'district_id', 'village', 'pin_code', 'land_holding_acres', 'crops', 'soil_type', 'irrigation_type', 'farming_type', 'status', 'onboarding_stage', 'profile_complete', 'primary_crop', 'state'];
      const sets = []; const vals = [];
      fields.forEach(f => { if (req.body[f] !== undefined) { vals.push(req.body[f]); sets.push(`${f}=$${vals.length}`); } });
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      vals.push(req.params.id);
      const r = await pool.query(`UPDATE farmers SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
            await auditLog('farmer.created', 'farmer', null, 'Created farmer', {type:'admin',id:req.user?.id||'unknown'}, 'info', req.body);
      res.json({ farmer: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
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

  // --- CHAT LABELS ---
  app.get('/api/v1/chat-labels', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM chat_labels ORDER BY name');
      res.json({ labels: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/chat-labels', auth, async (req, res) => {
    try {
      const { name, color } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const r = await pool.query('INSERT INTO chat_labels (id, name, color, created_at) VALUES (gen_random_uuid(), $1, $2, NOW()) RETURNING *', [name, color || '#6366f1']);
      res.json({ label: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/v1/chat-labels/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM chat_labels WHERE id=$1', [req.params.id]);
      res.json({ message: 'Label deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- CHAT NOTES ---
  app.get('/api/v1/chats/:id/notes', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT n.*, a.name as author_name FROM chat_notes n LEFT JOIN admin_users a ON n.author_id=a.id WHERE n.session_id=$1 ORDER BY n.created_at DESC', [req.params.id]);
      res.json({ notes: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/chats/:id/notes', auth, async (req, res) => {
    try {
      const { content } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });
      const r = await pool.query('INSERT INTO chat_notes (id, session_id, author_id, content, created_at) VALUES (gen_random_uuid(), $1, $2, $3, NOW()) RETURNING *', [req.params.id, req.user.id, content]);
      res.json({ note: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/v1/chat-notes/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM chat_notes WHERE id=$1', [req.params.id]);
      res.json({ message: 'Note deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- QUICK REPLIES ---
  app.get('/api/v1/quick-replies', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM quick_replies WHERE is_active=true ORDER BY category, title');
      res.json({ replies: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/quick-replies', auth, async (req, res) => {
    try {
      const { shortcode, title, content, category } = req.body;
      if (!shortcode || !title || !content) return res.status(400).json({ error: 'shortcode, title, content required' });
      const r = await pool.query('INSERT INTO quick_replies (id, shortcode, title, content, category, created_by, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW()) RETURNING *', [shortcode, title, content, category || 'general', req.user.id]);
      res.json({ reply: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/v1/quick-replies/:id', auth, async (req, res) => {
    try {
      const { shortcode, title, content, category, is_active } = req.body;
      const r = await pool.query('UPDATE quick_replies SET shortcode=COALESCE($1,shortcode), title=COALESCE($2,title), content=COALESCE($3,content), category=COALESCE($4,category), is_active=COALESCE($5,is_active) WHERE id=$6 RETURNING *', [shortcode, title, content, category, is_active, req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ reply: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/v1/quick-replies/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM quick_replies WHERE id=$1', [req.params.id]);
      res.json({ message: 'Quick reply deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- CHAT STATUS & LABELS UPDATE ---
  app.put('/api/v1/chats/:id/status', auth, async (req, res) => {
    try {
      const { chat_status, priority } = req.body;
      const updates = []; const vals = []; let idx = 1;
      if (chat_status) { updates.push('chat_status=$' + idx); vals.push(chat_status); idx++; }
      if (priority) { updates.push('priority=$' + idx); vals.push(priority); idx++; }
      if (chat_status === 'resolved') { updates.push('resolved_at=NOW()'); }
      updates.push('updated_at=NOW()');
      vals.push(req.params.id);
      const r = await pool.query('UPDATE wa_chat_sessions SET ' + updates.join(',') + ' WHERE id=$' + idx + ' RETURNING *', vals);
      if (!r.rows.length) return res.status(404).json({ error: 'Session not found' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/v1/chats/:id/labels', auth, async (req, res) => {
    try {
      const { labels } = req.body;
      const r = await pool.query('UPDATE wa_chat_sessions SET labels=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [labels || [], req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Session not found' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- AGENT STATUS ---
  app.put('/api/v1/agents/status', auth, async (req, res) => {
    try {
      const { agent_status } = req.body;
      await pool.query('UPDATE admin_users SET agent_status=$1 WHERE id=$2', [agent_status || 'offline', req.user.id]);
      res.json({ status: agent_status });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/v1/agents', auth, async (req, res) => {
    try {
      const r = await pool.query("SELECT id, name, email, role, agent_status, max_concurrent_chats FROM admin_users WHERE role != 'super_admin' ORDER BY name");
      res.json({ agents: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  

  // ===== AUTO-ASSIGNMENT RULES =====
  app.get('/api/v1/assignment-rules', auth, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM assignment_rules ORDER BY priority DESC, created_at');
      res.json({ rules: result.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/assignment-rules', auth, async (req, res) => {
    try {
      const { name, strategy, conditions, agent_pool, max_chats_per_agent, is_active } = req.body;
      if (!name) return res.status(400).json({ error: 'Name required' });
      const result = await pool.query(
        `INSERT INTO assignment_rules (name, strategy, conditions, agent_pool, max_chats_per_agent, is_active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [name, strategy || 'round_robin', conditions || {}, agent_pool || [], max_chats_per_agent || 20, is_active !== false]
      );
      res.json({ rule: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/v1/assignment-rules/:id', auth, async (req, res) => {
    try {
      const fields = Object.entries(req.body).filter(([k]) => !['id','created_at'].includes(k));
      if (fields.length === 0) return res.status(400).json({ error: 'No fields' });
      const sets = fields.map(([k], i) => `${k}=$${i+1}`).join(', ');
      const vals = fields.map(([,v]) => v);
      vals.push(req.params.id);
      const result = await pool.query(`UPDATE assignment_rules SET ${sets}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Rule not found' });
      res.json({ rule: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/v1/assignment-rules/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM assignment_rules WHERE id=$1', [req.params.id]);
      res.json({ message: 'Rule deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Auto-assign incoming chat (called internally)
  app.post('/api/v1/chats/auto-assign', auth, async (req, res) => {
    try {
      const { session_id, farmer_language, message_text } = req.body;
      if (!session_id) return res.status(400).json({ error: 'session_id required' });
      const rules = await pool.query('SELECT * FROM assignment_rules WHERE is_active=true ORDER BY priority DESC');
      let assignedAgent = null;
      for (const rule of rules.rows) {
        if (rule.conditions && rule.conditions.languages && farmer_language && !rule.conditions.languages.includes(farmer_language)) continue;
        if (rule.conditions && rule.conditions.keywords && message_text) {
          const hasKeyword = rule.conditions.keywords.some(kw => message_text.toLowerCase().includes(kw.toLowerCase()));
          if (!hasKeyword) continue;
        }
        let agentQuery = "SELECT id, current_chat_count, last_assigned_at FROM admin_users WHERE agent_status='online' AND role != 'super_admin'";
        let agentParams = [];
        if (rule.agent_pool && rule.agent_pool.length > 0) {
          agentQuery += " AND id = ANY($1)";
          agentParams.push(rule.agent_pool);
        }
        const agents = await pool.query(agentQuery, agentParams);
        const eligible = agents.rows.filter(a => a.current_chat_count < (rule.max_chats_per_agent || 20));
        if (eligible.length === 0) continue;
        if (rule.strategy === 'round_robin') {
          eligible.sort((a, b) => new Date(a.last_assigned_at) - new Date(b.last_assigned_at));
          assignedAgent = eligible[0];
        } else if (rule.strategy === 'least_load') {
          eligible.sort((a, b) => a.current_chat_count - b.current_chat_count);
          assignedAgent = eligible[0];
        }
        if (assignedAgent) break;
      }
      if (!assignedAgent) {
        const fallback = await pool.query("SELECT id, current_chat_count FROM admin_users WHERE agent_status='online' AND role != 'super_admin' ORDER BY current_chat_count ASC LIMIT 1");
        if (fallback.rows.length > 0) assignedAgent = fallback.rows[0];
      }
      if (assignedAgent) {
        await pool.query("UPDATE wa_chat_sessions SET assigned_to=$1, chat_status='assigned', updated_at=NOW() WHERE id=$2", [assignedAgent.id, session_id]);
        await pool.query("UPDATE admin_users SET last_assigned_at=NOW(), current_chat_count=current_chat_count+1 WHERE id=$1", [assignedAgent.id]);
        await pool.query("INSERT INTO assignment_history (session_id, assigned_to, reason) VALUES ($1, $2, 'auto_assignment')", [session_id, assignedAgent.id]);
        const session = await pool.query('SELECT priority FROM wa_chat_sessions WHERE id=$1', [session_id]);
        const priority = (session.rows[0] && session.rows[0].priority) || 'normal';
        const sla = await pool.query('SELECT * FROM sla_policies WHERE priority=$1 AND is_active=true LIMIT 1', [priority]);
        if (sla.rows.length > 0) {
          const dueAt = new Date(Date.now() + sla.rows[0].first_response_minutes * 60000);
          await pool.query("UPDATE wa_chat_sessions SET sla_policy_id=$1, sla_due_at=$2 WHERE id=$3", [sla.rows[0].id, dueAt, session_id]);
        }
        res.json({ assigned: true, agent_id: assignedAgent.id, strategy: 'auto' });
      } else {
        res.json({ assigned: false, reason: 'No agents available' });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== SLA POLICIES =====
  app.get('/api/v1/sla-policies', auth, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM sla_policies ORDER BY first_response_minutes');
      res.json({ policies: result.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/sla-policies', auth, async (req, res) => {
    try {
      const { name, priority, first_response_minutes, resolution_minutes, escalation_minutes, escalate_to, notify_channel } = req.body;
      if (!name || !priority) return res.status(400).json({ error: 'Name and priority required' });
      const result = await pool.query(
        "INSERT INTO sla_policies (name, priority, first_response_minutes, resolution_minutes, escalation_minutes, escalate_to, notify_channel) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [name, priority, first_response_minutes || 15, resolution_minutes || 240, escalation_minutes || 30, escalate_to || null, notify_channel || 'dashboard']
      );
      res.json({ policy: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/v1/sla-policies/:id', auth, async (req, res) => {
    try {
      const fields = Object.entries(req.body).filter(([k]) => !['id','created_at'].includes(k));
      if (fields.length === 0) return res.status(400).json({ error: 'No fields' });
      const sets = fields.map(([k], i) => `${k}=$${i+1}`).join(', ');
      const vals = fields.map(([,v]) => v);
      vals.push(req.params.id);
      const result = await pool.query(`UPDATE sla_policies SET ${sets} WHERE id=$${vals.length} RETURNING *`, vals);
      res.json({ policy: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/v1/sla-policies/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM sla_policies WHERE id=$1', [req.params.id]);
      res.json({ message: 'Policy deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // SLA breach check (called periodically or on-demand)
  app.post('/api/v1/sla/check-breaches', auth, async (req, res) => {
    try {
      const breached = await pool.query(`
        SELECT s.id as session_id, s.sla_policy_id, s.assigned_to, p.escalate_to, p.name as policy_name
        FROM wa_chat_sessions s
        JOIN sla_policies p ON s.sla_policy_id = p.id
        WHERE s.chat_status NOT IN ('resolved','closed')
          AND s.sla_due_at < NOW()
          AND s.escalated = false
      `);
      let breachCount = 0;
      for (const session of breached.rows) {
        await pool.query("INSERT INTO sla_breaches (session_id, policy_id, breach_type) VALUES ($1, $2, 'sla_breach')", [session.session_id, session.sla_policy_id]);
        if (session.escalate_to) {
          await pool.query("UPDATE wa_chat_sessions SET escalated=true, escalated_at=NOW(), escalated_to=$1, priority='urgent', updated_at=NOW() WHERE id=$2", [session.escalate_to, session.session_id]);
          await pool.query("INSERT INTO assignment_history (session_id, assigned_from, assigned_to, reason) VALUES ($1, $2, $3, 'sla_escalation')", [session.session_id, session.assigned_to, session.escalate_to]);
        } else {
          await pool.query("UPDATE wa_chat_sessions SET escalated=true, escalated_at=NOW(), priority='urgent', updated_at=NOW() WHERE id=$1", [session.session_id]);
        }
        breachCount++;
      }
      res.json({ breaches_found: breachCount, checked_at: new Date().toISOString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/v1/sla/breaches', auth, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT b.*, s.assigned_to, s.farmer_id, p.name as policy_name, f.name as farmer_name, f.phone
        FROM sla_breaches b
        JOIN wa_chat_sessions s ON b.session_id = s.id
        JOIN sla_policies p ON b.policy_id = p.id
        LEFT JOIN farmers f ON s.farmer_id = f.id
        WHERE b.acknowledged = false
        ORDER BY b.breached_at DESC LIMIT 50
      `);
      res.json({ breaches: result.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/v1/sla/breaches/:id/acknowledge', auth, async (req, res) => {
    try {
      const result = await pool.query("UPDATE sla_breaches SET acknowledged=true, acknowledged_by=$1, acknowledged_at=NOW() WHERE id=$2 RETURNING *", [req.user.id, req.params.id]);
      res.json({ breach: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== BULK ACTIONS =====
  app.post('/api/v1/chats/bulk/assign', auth, async (req, res) => {
    try {
      const { session_ids, agent_id } = req.body;
      if (!Array.isArray(session_ids) || session_ids.length === 0) return res.status(400).json({ error: 'session_ids array required' });
      if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
      const result = await pool.query("UPDATE wa_chat_sessions SET assigned_to=$1, chat_status='assigned', updated_at=NOW() WHERE id = ANY($2) RETURNING id", [agent_id, session_ids]);
      await pool.query("UPDATE admin_users SET current_chat_count = (SELECT COUNT(*) FROM wa_chat_sessions WHERE assigned_to=$1 AND chat_status NOT IN ('resolved','closed')) WHERE id=$1", [agent_id]);
      for (const row of result.rows) {
        await pool.query("INSERT INTO assignment_history (session_id, assigned_to, reason) VALUES ($1, $2, 'bulk_assign')", [row.id, agent_id]);
      }
      res.json({ updated: result.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/chats/bulk/label', auth, async (req, res) => {
    try {
      const { session_ids, labels, action } = req.body;
      if (!Array.isArray(session_ids) || !Array.isArray(labels)) return res.status(400).json({ error: 'session_ids and labels arrays required' });
      let query;
      if (action === 'add') {
        query = "UPDATE wa_chat_sessions SET labels = array_cat(labels, $1::text[]), updated_at=NOW() WHERE id = ANY($2) RETURNING id";
      } else {
        query = "UPDATE wa_chat_sessions SET labels = $1::text[], updated_at=NOW() WHERE id = ANY($2) RETURNING id";
      }
      const result = await pool.query(query, [labels, session_ids]);
      res.json({ updated: result.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/chats/bulk/status', auth, async (req, res) => {
    try {
      const { session_ids, status } = req.body;
      if (!Array.isArray(session_ids) || !status) return res.status(400).json({ error: 'session_ids and status required' });
      const validStatuses = ['open', 'assigned', 'pending', 'resolved', 'closed'];
      if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      const extra = (status === 'resolved') ? ', resolved_at=NOW()' : '';
      const result = await pool.query("UPDATE wa_chat_sessions SET chat_status=$1" + extra + ", updated_at=NOW() WHERE id = ANY($2) RETURNING id", [status, session_ids]);
      if (status === 'resolved' || status === 'closed') {
        await pool.query("UPDATE admin_users SET current_chat_count = (SELECT COUNT(*) FROM wa_chat_sessions WHERE assigned_to=admin_users.id AND chat_status NOT IN ('resolved','closed')) WHERE id IN (SELECT DISTINCT assigned_to FROM wa_chat_sessions WHERE id = ANY($1) AND assigned_to IS NOT NULL)", [session_ids]);
      }
      res.json({ updated: result.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Export chats as CSV
  app.get('/api/v1/chats/export/csv', auth, async (req, res) => {
    try {
      const { status, assigned_to, from_date, to_date, labels } = req.query;
      let query = "SELECT s.id, s.chat_status, s.priority, s.labels, s.created_at, s.resolved_at, s.unread_count, f.name as farmer_name, f.phone as farmer_phone, f.language, f.primary_crop, a.name as agent_name, (SELECT COUNT(*) FROM wa_messages WHERE session_id=s.id) as message_count, s.first_response_at, s.sla_due_at, s.escalated FROM wa_chat_sessions s LEFT JOIN farmers f ON s.farmer_id = f.id LEFT JOIN admin_users a ON s.assigned_to = a.id WHERE 1=1";
      const params = [];
      let paramIdx = 1;
      if (status) { query += " AND s.chat_status=$" + paramIdx++; params.push(status); }
      if (assigned_to) { query += " AND s.assigned_to=$" + paramIdx++; params.push(assigned_to); }
      if (from_date) { query += " AND s.created_at >= $" + paramIdx++; params.push(from_date); }
      if (to_date) { query += " AND s.created_at <= $" + paramIdx++; params.push(to_date); }
      if (labels) { query += " AND s.labels && $" + paramIdx++ + "::text[]"; params.push(labels.split(',')); }
      query += ' ORDER BY s.created_at DESC LIMIT 5000';
      const result = await pool.query(query, params);
      const headers = ['ID','Status','Priority','Farmer Name','Phone','Language','Crop','Agent','Messages','Labels','Created','Resolved','First Response','SLA Due','Escalated'];
      let csv = headers.join(',') + '\n';
      for (const row of result.rows) {
        csv += [row.id, row.chat_status, row.priority, '"' + (row.farmer_name || '').replace(/"/g, '""') + '"', row.farmer_phone, row.language, row.primary_crop || '', '"' + (row.agent_name || 'Unassigned').replace(/"/g, '""') + '"', row.message_count, '"' + (row.labels || []).join(';') + '"', row.created_at, row.resolved_at || '', row.first_response_at || '', row.sla_due_at || '', row.escalated ? 'Yes' : 'No'].join(',') + '\n';
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="chats_export_' + new Date().toISOString().split('T')[0] + '.csv"');
      res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== CHAT ANALYTICS =====
  app.get('/api/v1/chat-analytics', auth, async (req, res) => {
    try {
      const { period } = req.query;
      let since = new Date();
      if (period === 'week') since.setDate(since.getDate() - 7);
      else if (period === 'month') since.setDate(since.getDate() - 30);
      else since.setHours(0, 0, 0, 0);
      const [total, open, resolved, breaches, avgResponse, agentStats] = await Promise.all([
        pool.query("SELECT COUNT(*) as count FROM wa_chat_sessions WHERE created_at >= $1", [since]),
        pool.query("SELECT COUNT(*) as count FROM wa_chat_sessions WHERE chat_status NOT IN ('resolved','closed') AND created_at >= $1", [since]),
        pool.query("SELECT COUNT(*) as count FROM wa_chat_sessions WHERE chat_status='resolved' AND resolved_at >= $1", [since]),
        pool.query("SELECT COUNT(*) as count FROM sla_breaches WHERE breached_at >= $1 AND acknowledged=false", [since]),
        pool.query("SELECT AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/60) as avg_minutes FROM wa_chat_sessions WHERE first_response_at IS NOT NULL AND created_at >= $1", [since]),
        pool.query("SELECT a.id, a.name, a.agent_status, a.current_chat_count, COUNT(s.id) as total_handled, AVG(EXTRACT(EPOCH FROM (s.first_response_at - s.created_at))/60) as avg_response_min FROM admin_users a LEFT JOIN wa_chat_sessions s ON s.assigned_to = a.id AND s.created_at >= $1 WHERE a.role != 'super_admin' GROUP BY a.id, a.name, a.agent_status, a.current_chat_count", [since])
      ]);
      res.json({
        period: period || 'today',
        total_chats: parseInt(total.rows[0].count),
        open_chats: parseInt(open.rows[0].count),
        resolved_chats: parseInt(resolved.rows[0].count),
        sla_breaches: parseInt(breaches.rows[0].count),
        avg_first_response_min: Math.round(parseFloat(avgResponse.rows[0].avg_minutes) || 0),
        agents: agentStats.rows
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
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
            await auditLog('template.created', 'template', null, 'Created template', {type:'admin',id:req.user?.id||'unknown'}, 'info', {name:req.body.name});
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
  
  // ---
  // Submit template to Meta for approval
  app.post('/api/v1/templates/:id/submit-to-meta', auth, async (req, res) => {
    try {
      const template = await pool.query('SELECT * FROM message_templates WHERE id=$1', [req.params.id]);
      if (!template.rows.length) return res.status(404).json({ error: 'Template not found' });
      const t = template.rows[0];
      const wabaId = process.env.WABA_ID;
      const token = process.env.WA_ACCESS_TOKEN;
      if (!wabaId || !token) return res.status(400).json({ error: 'WABA_ID or WA_ACCESS_TOKEN not configured' });
  
      // Extract variables from template text ({{1}}, {{2}}, etc.)
      const varMatches = (t.template_text || '').match(/\{\{(\d+)\}\}/g) || [];
      const varCount = varMatches.length;
      const exampleValues = req.body.example_values || [];
      // Fill missing examples with placeholder
      while (exampleValues.length < varCount) exampleValues.push('example_' + (exampleValues.length + 1));
  
      // Build Meta template components
      const bodyComponent = { type: 'BODY', text: t.template_text };
      if (varCount > 0) {
        bodyComponent.example = { body_text: [exampleValues.slice(0, varCount)] };
      }
  
      const components = [bodyComponent];
      if (req.body.header_text) components.unshift({ type: 'HEADER', format: 'TEXT', text: req.body.header_text });
      if (req.body.footer_text) components.push({ type: 'FOOTER', text: req.body.footer_text });
      if (req.body.buttons) components.push({ type: 'BUTTONS', buttons: req.body.buttons });
  
      const langMap = { hi: 'hi', en: 'en_US', mr: 'mr', gu: 'gu', pa: 'pa', bn: 'bn', ta: 'ta', te: 'te', kn: 'kn' };
      const templateName = t.wa_template_name || t.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  
      const metaResp = await axios.post(
        'https://graph.facebook.com/v21.0/' + wabaId + '/message_templates',
        {
          name: templateName,
          language: langMap[t.language] || 'hi',
          category: (t.category || 'marketing').toUpperCase(),
          components: components
        },
        { headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } }
      );
  
      // Update local template with Meta ID and status
      await pool.query(
        'UPDATE message_templates SET meta_template_id=$1, status=$2, wa_template_name=COALESCE(wa_template_name,$3) WHERE id=$4',
        [metaResp.data.id, 'pending', templateName, req.params.id]
      );
  
      res.json({ success: true, meta_id: metaResp.data.id, status: metaResp.data.status || 'PENDING' });
    } catch (e) {
      const metaError = e.response ? e.response.data : { message: e.message };
      console.error('Meta template submit error:', metaError);
      res.status(500).json({ error: 'Meta API error', details: metaError });
    }
  });
  
  
  // Sync template status from Meta
  app.post('/api/v1/templates/:id/sync-meta', auth, async (req, res) => {
    try {
      const template = await pool.query('SELECT * FROM message_templates WHERE id=$1', [req.params.id]);
      if (!template.rows.length) return res.status(404).json({ error: 'Template not found' });
      const t = template.rows[0];
      const wabaId = process.env.WABA_ID;
      const token = process.env.WA_ACCESS_TOKEN;
  
      const metaResp = await axios.get(
        'https://graph.facebook.com/v21.0/' + wabaId + '/message_templates?name=' + (t.wa_template_name || ''),
        { headers: { 'Authorization': 'Bearer ' + token } }
      );
  
      if (metaResp.data.data && metaResp.data.data.length) {
        const mt = metaResp.data.data[0];
        await pool.query(
          'UPDATE message_templates SET meta_template_id=$1, status=$2 WHERE id=$3',
          [mt.id, mt.status.toLowerCase(), req.params.id]
        );
        res.json({ success: true, meta_status: mt.status, meta_id: mt.id });
      } else {
        res.json({ success: false, message: 'Template not found on Meta' });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  
  // Fetch all templates from Meta (sync all)
  app.get('/api/v1/templates/meta/all', auth, async (req, res) => {
    try {
      const wabaId = process.env.WABA_ID;
      const token = process.env.WA_ACCESS_TOKEN;
      if (!wabaId || !token) return res.status(400).json({ error: 'WABA_ID or WA_ACCESS_TOKEN not configured' });
  
      const metaResp = await axios.get(
        'https://graph.facebook.com/v21.0/' + wabaId + '/message_templates?limit=100',
        { headers: { 'Authorization': 'Bearer ' + token } }
      );
  
      res.json({ templates: metaResp.data.data || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  
  // Delete template from Meta
  app.delete('/api/v1/templates/:id/meta', auth, async (req, res) => {
    try {
      const template = await pool.query('SELECT * FROM message_templates WHERE id=$1', [req.params.id]);
      if (!template.rows.length) return res.status(404).json({ error: 'Template not found' });
      const t = template.rows[0];
      const wabaId = process.env.WABA_ID;
      const token = process.env.WA_ACCESS_TOKEN;
  
      await axios.delete(
        'https://graph.facebook.com/v21.0/' + wabaId + '/message_templates?name=' + (t.wa_template_name || ''),
        { headers: { 'Authorization': 'Bearer ' + token } }
      );
  
      await pool.query('UPDATE message_templates SET status=$1 WHERE id=$2', ['deleted', req.params.id]);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  
  // ---
  
  // Get audience count based on filters (preview before sending)
  app.post('/api/v1/campaigns/audience-count', auth, async (req, res) => {
    try {
      const { district, state, crop, language, soil_type, irrigation_type, farming_type, min_land, max_land, active_days } = req.body;
      let q = 'SELECT COUNT(*) FROM farmers f LEFT JOIN districts_master d ON f.district_id=d.id WHERE f.status=\'active\' AND f.phone IS NOT NULL';
      const p = [];
      if (state) { p.push('%' + state + '%'); q += ` AND d.state_name ILIKE $${p.length}`; }
      if (district) { p.push('%' + district + '%'); q += ` AND d.district_name ILIKE $${p.length}`; }
      if (crop) { p.push('%' + crop + '%'); q += ` AND f.crops::text ILIKE $${p.length}`; }
      if (language) { p.push(language); q += ` AND f.language=$${p.length}`; }
      if (soil_type) { p.push('%' + soil_type + '%'); q += ` AND f.soil_type ILIKE $${p.length}`; }
      if (irrigation_type) { p.push('%' + irrigation_type + '%'); q += ` AND f.irrigation_type ILIKE $${p.length}`; }
      if (farming_type) { p.push('%' + farming_type + '%'); q += ` AND f.farming_type ILIKE $${p.length}`; }
      if (min_land) { p.push(min_land); q += ` AND f.land_holding_acres >= $${p.length}`; }
      if (max_land) { p.push(max_land); q += ` AND f.land_holding_acres <= $${p.length}`; }
      if (active_days) { p.push(active_days); q += ` AND f.updated_at > NOW() - INTERVAL '1 day' * $${p.length}`; }
      const r = await pool.query(q, p);
      res.json({ count: +r.rows[0].count });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // Get filter options (distinct values for dropdowns)
  app.get('/api/v1/campaigns/filter-options', auth, async (req, res) => {
    try {
      const [states, crops, soilTypes, irrigationTypes, farmingTypes, languages] = await Promise.all([
        pool.query('SELECT DISTINCT d.state_name FROM farmers f JOIN districts_master d ON f.district_id=d.id WHERE d.state_name IS NOT NULL ORDER BY d.state_name'),
        pool.query("SELECT DISTINCT unnest(crops) as crop FROM farmers WHERE crops IS NOT NULL ORDER BY crop"),
        pool.query('SELECT DISTINCT soil_type FROM farmers WHERE soil_type IS NOT NULL AND soil_type != \'\' ORDER BY soil_type'),
        pool.query('SELECT DISTINCT irrigation_type FROM farmers WHERE irrigation_type IS NOT NULL AND irrigation_type != \'\' ORDER BY irrigation_type'),
        pool.query('SELECT DISTINCT farming_type FROM farmers WHERE farming_type IS NOT NULL AND farming_type != \'\' ORDER BY farming_type'),
        pool.query('SELECT DISTINCT language FROM farmers WHERE language IS NOT NULL ORDER BY language')
      ]);
      res.json({
        states: states.rows.map(r => r.state_name),
        crops: crops.rows.map(r => r.crop),
        soil_types: soilTypes.rows.map(r => r.soil_type),
        irrigation_types: irrigationTypes.rows.map(r => r.irrigation_type),
        farming_types: farmingTypes.rows.map(r => r.farming_type),
        languages: languages.rows.map(r => r.language)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // Get districts for a state
  app.get('/api/v1/campaigns/districts', auth, async (req, res) => {
    try {
      const { state } = req.query;
      let q = 'SELECT DISTINCT d.district_name FROM farmers f JOIN districts_master d ON f.district_id=d.id WHERE d.district_name IS NOT NULL';
      const p = [];
      if (state) { p.push('%' + state + '%'); q += ` AND d.state_name ILIKE $${p.length}`; }
      q += ' ORDER BY d.district_name';
      const r = await pool.query(q, p);
      res.json({ districts: r.rows.map(r => r.district_name) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // List all campaigns
  app.get('/api/v1/campaigns', auth, async (req, res) => {
    try {
      const r = await pool.query(`SELECT c.*, t.name as template_name, t.wa_template_name, t.template_text, t.status as template_status,
        (SELECT COUNT(*) FROM campaign_messages WHERE campaign_id=c.id) as total_messages,
        (SELECT COUNT(*) FROM campaign_messages WHERE campaign_id=c.id AND status='sent') as sent_count,
        (SELECT COUNT(*) FROM campaign_messages WHERE campaign_id=c.id AND status='delivered') as delivered_count,
        (SELECT COUNT(*) FROM campaign_messages WHERE campaign_id=c.id AND status='read') as read_count,
        (SELECT COUNT(*) FROM campaign_messages WHERE campaign_id=c.id AND status='failed') as failed_count
        FROM campaigns c LEFT JOIN message_templates t ON c.template_id=t.id ORDER BY c.created_at DESC`);
      res.json({ campaigns: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // Create campaign
  app.post('/api/v1/campaigns', auth, async (req, res) => {
    try {
      const { name, template_id, target_criteria, scheduled_at } = req.body;
      if (!name) return res.status(400).json({ error: 'Campaign name is required' });
  
      // Count target audience
      let targetCount = 0;
      if (target_criteria) {
        let cq = "SELECT COUNT(*) FROM farmers f LEFT JOIN districts_master d ON f.district_id=d.id WHERE f.status='active' AND f.phone IS NOT NULL";
        const p = [];
        if (target_criteria.state) { p.push('%' + target_criteria.state + '%'); cq += ` AND d.state_name ILIKE $${p.length}`; }
        if (target_criteria.district) { p.push('%' + target_criteria.district + '%'); cq += ` AND d.district_name ILIKE $${p.length}`; }
        if (target_criteria.crop) { p.push('%' + target_criteria.crop + '%'); cq += ` AND f.crops::text ILIKE $${p.length}`; }
        if (target_criteria.language) { p.push(target_criteria.language); cq += ` AND f.language=$${p.length}`; }
        if (target_criteria.soil_type) { p.push('%' + target_criteria.soil_type + '%'); cq += ` AND f.soil_type ILIKE $${p.length}`; }
        if (target_criteria.irrigation_type) { p.push('%' + target_criteria.irrigation_type + '%'); cq += ` AND f.irrigation_type ILIKE $${p.length}`; }
        if (target_criteria.farming_type) { p.push('%' + target_criteria.farming_type + '%'); cq += ` AND f.farming_type ILIKE $${p.length}`; }
        if (target_criteria.min_land) { p.push(target_criteria.min_land); cq += ` AND f.land_holding_acres >= $${p.length}`; }
        if (target_criteria.max_land) { p.push(target_criteria.max_land); cq += ` AND f.land_holding_acres <= $${p.length}`; }
        if (target_criteria.active_days) { p.push(target_criteria.active_days); cq += ` AND f.updated_at > NOW() - INTERVAL '1 day' * $${p.length}`; }
        const tc = await pool.query(cq, p);
        targetCount = +tc.rows[0].count;
      }
  
      const r = await pool.query(
        `INSERT INTO campaigns (name, template_id, target_criteria, target_count, scheduled_at, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING *`,
        [name, template_id || null, JSON.stringify(target_criteria || {}), targetCount, scheduled_at || null, req.user.id]
      );
      res.json({ campaign: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // Update campaign
  app.put('/api/v1/campaigns/:id', auth, async (req, res) => {
    try {
      const { name, template_id, target_criteria, status, scheduled_at } = req.body;
      const r = await pool.query(
        `UPDATE campaigns SET name=COALESCE($1,name), template_id=COALESCE($2,template_id),
         target_criteria=COALESCE($3,target_criteria), status=COALESCE($4,status),
         scheduled_at=COALESCE($5,scheduled_at), updated_at=NOW() WHERE id=$6 RETURNING *`,
        [name, template_id, target_criteria ? JSON.stringify(target_criteria) : null, status, scheduled_at, req.params.id]
      );
      res.json({ campaign: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // Delete campaign
  app.delete('/api/v1/campaigns/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM campaign_messages WHERE campaign_id=$1', [req.params.id]);
      await pool.query('DELETE FROM campaigns WHERE id=$1', [req.params.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // LAUNCH campaign - send messages to all matching farmers
  app.post('/api/v1/campaigns/:id/launch', auth, async (req, res) => {
    try {
      const camp = await pool.query('SELECT c.*, t.wa_template_name, t.template_text, t.language, t.status as template_status FROM campaigns c LEFT JOIN message_templates t ON c.template_id=t.id WHERE c.id=$1', [req.params.id]);
      if (!camp.rows.length) return res.status(404).json({ error: 'Campaign not found' });
      const c = camp.rows[0];
      if (!c.template_id) return res.status(400).json({ error: 'No template assigned to this campaign' });
      if (c.template_status !== 'approved') return res.status(400).json({ error: 'Template must be approved by Meta before launching' });
  
      const token = process.env.WA_ACCESS_TOKEN;
      const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
      if (!token || !phoneNumberId) return res.status(400).json({ error: 'WA_ACCESS_TOKEN or WA_PHONE_NUMBER_ID not configured' });
  
      // Get target farmers
      const criteria = typeof c.target_criteria === 'string' ? JSON.parse(c.target_criteria) : (c.target_criteria || {});
      let farmers;
      if (criteria.farmer_ids && Array.isArray(criteria.farmer_ids)) {
        // Retarget campaign ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â use specific farmer IDs
        const idPlaceholders = criteria.farmer_ids.map((_, i) => '$' + (i + 1)).join(',');
        farmers = await pool.query(
          `SELECT f.id, f.phone, f.name, f.crops, f.village FROM farmers f WHERE f.id IN (${idPlaceholders}) AND f.status='active' AND f.phone IS NOT NULL`,
          criteria.farmer_ids
        );
      } else {
        // Normal campaign ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â use filters
        let fq = "SELECT f.id, f.phone, f.name, f.crops, f.village FROM farmers f LEFT JOIN districts_master d ON f.district_id=d.id WHERE f.status='active' AND f.phone IS NOT NULL";
        const fp = [];
        if (criteria.state) { fp.push('%' + criteria.state + '%'); fq += ` AND d.state_name ILIKE $${fp.length}`; }
        if (criteria.district) { fp.push('%' + criteria.district + '%'); fq += ` AND d.district_name ILIKE $${fp.length}`; }
        if (criteria.crop) { fp.push('%' + criteria.crop + '%'); fq += ` AND f.crops::text ILIKE $${fp.length}`; }
        if (criteria.language) { fp.push(criteria.language); fq += ` AND f.language=$${fp.length}`; }
        if (criteria.soil_type) { fp.push('%' + criteria.soil_type + '%'); fq += ` AND f.soil_type ILIKE $${fp.length}`; }
        if (criteria.irrigation_type) { fp.push('%' + criteria.irrigation_type + '%'); fq += ` AND f.irrigation_type ILIKE $${fp.length}`; }
        if (criteria.farming_type) { fp.push('%' + criteria.farming_type + '%'); fq += ` AND f.farming_type ILIKE $${fp.length}`; }
        if (criteria.min_land) { fp.push(criteria.min_land); fq += ` AND f.land_holding_acres >= $${fp.length}`; }
        if (criteria.max_land) { fp.push(criteria.max_land); fq += ` AND f.land_holding_acres <= $${fp.length}`; }
        if (criteria.active_days) { fp.push(criteria.active_days); fq += ` AND f.updated_at > NOW() - INTERVAL '1 day' * $${fp.length}`; }
        farmers = await pool.query(fq, fp);
      }
  
  
      if (!farmers.rows.length) return res.status(400).json({ error: 'No farmers match the target criteria' });
  
      // Update campaign status
      await pool.query("UPDATE campaigns SET status='sending', sent_at=NOW(), target_count=$1 WHERE id=$2", [farmers.rows.length, req.params.id]);
  
      // Language map
      const langMap = { hi: 'hi', en: 'en_US', mr: 'mr', gu: 'gu', pa: 'pa', bn: 'bn', ta: 'ta', te: 'te', kn: 'kn' };
      const templateLang = langMap[c.language] || 'hi';
  
      // Send messages asynchronously
      let sentCount = 0, failedCount = 0;
      const results = [];
  
      for (const farmer of farmers.rows) {
        try {
          const phone = farmer.phone.startsWith('91') ? farmer.phone : '91' + farmer.phone;
  
          // Build template parameters from farmer data
          const params = [];
          const varMatches = (c.template_text || '').match(/\{\{(\d+)\}\}/g) || [];
          for (let i = 0; i < varMatches.length; i++) {
            if (i === 0) params.push({ type: 'text', text: farmer.name || 'Kisan' });
            else if (i === 1) params.push({ type: 'text', text: (Array.isArray(farmer.crops) ? farmer.crops[0] : (farmer.crops || 'fasal')) });
            else if (i === 2) params.push({ type: 'text', text: farmer.village || 'aapka area' });
            else params.push({ type: 'text', text: 'info' });
          }
  
          const msgBody = {
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: {
              name: c.wa_template_name,
              language: { code: templateLang },
              components: params.length ? [{ type: 'body', parameters: params }] : []
            }
          };
  
          const resp = await axios.post(
            'https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages',
            msgBody,
            { headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } }
          );
  
          const waMessageId = resp.data.messages && resp.data.messages[0] ? resp.data.messages[0].id : null;
          await pool.query(
            'INSERT INTO campaign_messages (campaign_id, farmer_id, phone, wa_message_id, status, sent_at) VALUES ($1,$2,$3,$4,$5,NOW())',
            [req.params.id, farmer.id, phone, waMessageId, 'sent']
          );
          sentCount++;
          results.push({ farmer_id: farmer.id, status: 'sent' });
  
          // Rate limit: 80 messages per second max, we do 20/sec to be safe
          if (sentCount % 20 === 0) await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
          failedCount++;
          const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
          await pool.query(
            'INSERT INTO campaign_messages (campaign_id, farmer_id, phone, status, error_message, sent_at) VALUES ($1,$2,$3,$4,$5,NOW())',
            [req.params.id, farmer.id, farmer.phone, 'failed', errMsg.substring(0, 500)]
          );
          results.push({ farmer_id: farmer.id, status: 'failed', error: errMsg.substring(0, 100) });
        }
      }
  
      // Update campaign final status
      await pool.query(
        "UPDATE campaigns SET status='completed', sent_count=$1, delivered_count=$1, target_count=$2 WHERE id=$3",
        [sentCount, farmers.rows.length, req.params.id]
      );
  
            await auditLog('campaign.launched', 'campaign', req.params.id, 'Launched campaign', {type:'admin',id:req.user?.id||'unknown'}, 'info', {campaign_id:req.params.id});
      res.json({ success: true, total: farmers.rows.length, sent: sentCount, failed: failedCount });
    } catch (e) {
      console.error('Campaign launch error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
  
  // Get campaign details with message stats
  app.get('/api/v1/campaigns/:id', auth, async (req, res) => {
    try {
      const camp = await pool.query('SELECT c.*, t.name as template_name, t.wa_template_name, t.template_text FROM campaigns c LEFT JOIN message_templates t ON c.template_id=t.id WHERE c.id=$1', [req.params.id]);
      if (!camp.rows.length) return res.status(404).json({ error: 'Campaign not found' });
      const messages = await pool.query(
        `SELECT cm.*, f.name as farmer_name, f.village FROM campaign_messages cm LEFT JOIN farmers f ON cm.farmer_id=f.id WHERE cm.campaign_id=$1 ORDER BY cm.sent_at DESC LIMIT 200`,
        [req.params.id]
      );
      const stats = await pool.query(
        `SELECT status, COUNT(*) as count FROM campaign_messages WHERE campaign_id=$1 GROUP BY status`,
        [req.params.id]
      );
      res.json({ campaign: camp.rows[0], messages: messages.rows, stats: stats.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Export campaign messages as CSV
  app.get('/api/v1/campaigns/:id/export', async (req, res) => {
    try {
      const token = req.query.token;
      if (!token) return res.status(401).json({ error: 'Token required' });
      try { require('jsonwebtoken').verify(token, process.env.JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
  
      const camp = await pool.query('SELECT name FROM campaigns WHERE id=$1', [req.params.id]);
      const msgs = await pool.query(
        `SELECT f.name as farmer_name, cm.phone, f.village, f.crops::text as crops, cm.status, cm.error_message, cm.sent_at, cm.delivered_at, cm.read_at
         FROM campaign_messages cm LEFT JOIN farmers f ON cm.farmer_id=f.id WHERE cm.campaign_id=$1 ORDER BY cm.sent_at`,
        [req.params.id]
      );
      const campName = camp.rows.length ? camp.rows[0].name.replace(/[^a-zA-Z0-9]/g, '_') : 'campaign';
      let csv = 'Farmer Name,Phone,Village,Crops,Status,Error,Sent At,Delivered At,Read At\n';
      msgs.rows.forEach(function(m) {
        csv += '"' + (m.farmer_name||'') + '","' + (m.phone||'') + '","' + (m.village||'') + '","' + (m.crops||'') + '","' + (m.status||'') + '","' + (m.error_message||'').replace(/"/g,'""') + '","' + (m.sent_at||'') + '","' + (m.delivered_at||'') + '","' + (m.read_at||'') + '"\n';
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=campaign_' + campName + '.csv');
      res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // Retarget campaign - create new campaign targeting read/not_read/failed farmers
  app.post('/api/v1/campaigns/:id/retarget', auth, async (req, res) => {
    try {
      const { type } = req.body; // 'read', 'not_read', 'failed'
      const camp = await pool.query('SELECT * FROM campaigns WHERE id=$1', [req.params.id]);
      if (!camp.rows.length) return res.status(404).json({ error: 'Campaign not found' });
      const c = camp.rows[0];
  
      let statusFilter;
      let label;
      if (type === 'read') { statusFilter = "status='read'"; label = 'Retarget: Read'; }
      else if (type === 'not_read') { statusFilter = "status IN ('sent','delivered')"; label = 'Retarget: Not Read'; }
      else if (type === 'failed') { statusFilter = "status='failed'"; label = 'Retarget: Failed'; }
      else return res.status(400).json({ error: 'Invalid retarget type. Use: read, not_read, failed' });
  
      const farmers = await pool.query(
        `SELECT DISTINCT farmer_id FROM campaign_messages WHERE campaign_id=$1 AND ${statusFilter}`,
        [req.params.id]
      );
  
      if (!farmers.rows.length) return res.status(400).json({ error: 'No farmers match the retarget criteria' });
  
      // Create new campaign with farmer IDs stored in target_criteria
      const farmerIds = farmers.rows.map(function(r) { return r.farmer_id; });
      const newCamp = await pool.query(
        `INSERT INTO campaigns (name, template_id, target_criteria, target_count, created_by, status)
         VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING *`,
        [
          c.name + ' - ' + label,
          c.template_id,
          JSON.stringify({ retarget_from: req.params.id, retarget_type: type, farmer_ids: farmerIds }),
          farmerIds.length,
          req.user.id
        ]
      );
  
      res.json({ campaign: newCamp.rows[0], farmer_count: farmerIds.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  
  // ==================== LOYALTY PROGRAM ====================
  
  // GET /api/v1/loyalty/overview - Dashboard stats
  app.get('/api/v1/loyalty/overview', auth, async (req, res) => {
    try {
      const [totalMembers, activeMembers, totalPointsIssued, totalPointsRedeemed, pendingRedemptions, tierDistribution] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM farmers WHERE loyalty_points > 0'),
        pool.query("SELECT COUNT(*) FROM farmers WHERE loyalty_points > 0 AND updated_at > NOW() - INTERVAL '30 days'"),
        pool.query("SELECT COALESCE(SUM(points),0) as total FROM loyalty_transactions WHERE type='earn'"),
        pool.query("SELECT COALESCE(SUM(points),0) as total FROM loyalty_transactions WHERE type='redeem'"),
        pool.query("SELECT COUNT(*) FROM redemption_requests WHERE status='pending'"),
        pool.query(`SELECT lt.name, lt.color, lt.icon, COUNT(f.id) as count 
                    FROM loyalty_tiers lt LEFT JOIN farmers f ON f.loyalty_tier_id = lt.id 
                    GROUP BY lt.id, lt.name, lt.color, lt.icon ORDER BY lt.sort_order`)
      ]);
      res.json({
        total_members: +totalMembers.rows[0].count,
        active_members: +activeMembers.rows[0].count,
        total_points_issued: +totalPointsIssued.rows[0].total,
        total_points_redeemed: +totalPointsRedeemed.rows[0].total,
        pending_redemptions: +pendingRedemptions.rows[0].count,
        tier_distribution: tierDistribution.rows
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/loyalty/tiers - List all tiers
  app.get('/api/v1/loyalty/tiers', auth, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM loyalty_tiers ORDER BY sort_order');
      res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUT /api/v1/loyalty/tiers/:id - Update a tier
  app.put('/api/v1/loyalty/tiers/:id', auth, async (req, res) => {
    try {
      const { name, min_points, max_points, multiplier, benefits, color, icon, active } = req.body;
      const result = await pool.query(
        `UPDATE loyalty_tiers SET name=$1, min_points=$2, max_points=$3, multiplier=$4, benefits=$5, color=$6, icon=$7, active=$8 WHERE id=$9 RETURNING *`,
        [name, min_points, max_points, multiplier, JSON.stringify(benefits), color, icon, active, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/loyalty/transactions - List transactions with filters
  app.get('/api/v1/loyalty/transactions', auth, async (req, res) => {
    try {
      const { farmer_id, type, source, limit = 50, offset = 0 } = req.query;
      let where = [];
      let params = [];
      let idx = 1;
      if (farmer_id) { where.push(`lt.farmer_id = $${idx++}`); params.push(farmer_id); }
      if (type) { where.push(`lt.type = $${idx++}`); params.push(type); }
      if (source) { where.push(`lt.source = $${idx++}`); params.push(source); }
      const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const result = await pool.query(
        `SELECT lt.*, f.name as farmer_name, f.phone as farmer_phone
         FROM loyalty_transactions lt LEFT JOIN farmers f ON f.id = lt.farmer_id
         ${whereClause} ORDER BY lt.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, limit, offset]
      );
      res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // POST /api/v1/loyalty/points - Manually award/deduct points
  app.post('/api/v1/loyalty/points', auth, async (req, res) => {
    try {
      const { farmer_id, points, type = 'earn', source = 'manual', description } = req.body;
      if (!farmer_id || !points) return res.status(400).json({ error: 'farmer_id and points required' });
  
      const farmer = await pool.query('SELECT id, name, phone, loyalty_points FROM farmers WHERE id = $1', [farmer_id]);
      if (!farmer.rows.length) return res.status(404).json({ error: 'Farmer not found' });
  
      const currentPoints = farmer.rows[0].loyalty_points || 0;
      const newBalance = type === 'redeem' ? currentPoints - Math.abs(points) : currentPoints + Math.abs(points);
      if (newBalance < 0) return res.status(400).json({ error: 'Insufficient points' });
  
      const lifetimeAdd = type === 'earn' ? Math.abs(points) : 0;
  
      await pool.query(
        'UPDATE farmers SET loyalty_points = $1, lifetime_points = COALESCE(lifetime_points,0) + $2 WHERE id = $3',
        [newBalance, lifetimeAdd, farmer_id]
      );
  
      const txn = await pool.query(
        `INSERT INTO loyalty_transactions (farmer_id, type, points, balance_after, source, description)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [farmer_id, type, Math.abs(points), newBalance, source, description || `Manual ${type} by admin`]
      );
  
      // Update tier
      const tier = await pool.query(
        'SELECT id, name FROM loyalty_tiers WHERE min_points <= $1 AND (max_points IS NULL OR max_points >= $1) AND active = true ORDER BY min_points DESC LIMIT 1',
        [type === 'earn' ? (farmer.rows[0].lifetime_points || 0) + lifetimeAdd : farmer.rows[0].lifetime_points || 0]
      );
      if (tier.rows.length) {
        await pool.query('UPDATE farmers SET loyalty_tier_id = $1, tier_updated_at = NOW() WHERE id = $2', [tier.rows[0].id, farmer_id]);
      }
  
      res.json({ transaction: txn.rows[0], new_balance: newBalance, tier: tier.rows[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/loyalty/catalog - List redemption items
  app.get('/api/v1/loyalty/catalog', auth, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM redemption_catalog ORDER BY sort_order');
      res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // POST /api/v1/loyalty/catalog - Add catalog item
  app.post('/api/v1/loyalty/catalog', auth, async (req, res) => {
    try {
      const { name, description, category, points_required, value_inr, redemption_type, stock } = req.body;
      const result = await pool.query(
        `INSERT INTO redemption_catalog (name, description, category, points_required, value_inr, redemption_type, stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [name, description, category, points_required, value_inr, redemption_type, stock || -1]
      );
      res.json(result.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUT /api/v1/loyalty/catalog/:id - Update catalog item
  app.put('/api/v1/loyalty/catalog/:id', auth, async (req, res) => {
    try {
      const { name, description, category, points_required, value_inr, redemption_type, stock, active } = req.body;
      const result = await pool.query(
        `UPDATE redemption_catalog SET name=$1, description=$2, category=$3, points_required=$4, value_inr=$5, redemption_type=$6, stock=$7, active=$8 WHERE id=$9 RETURNING *`,
        [name, description, category, points_required, value_inr, redemption_type, stock, active, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/loyalty/redemptions - List redemption requests
  app.get('/api/v1/loyalty/redemptions', auth, async (req, res) => {
    try {
      const { status, limit = 50, offset = 0 } = req.query;
      const where = status ? 'WHERE rr.status = $1' : '';
      const params = status ? [status, limit, offset] : [limit, offset];
      const result = await pool.query(
        `SELECT rr.*, f.name as farmer_name, f.phone as farmer_phone, f.loyalty_points,
                rc.name as item_name, rc.category, rc.redemption_type
         FROM redemption_requests rr
         LEFT JOIN farmers f ON f.id = rr.farmer_id
         LEFT JOIN redemption_catalog rc ON rc.id = rr.catalog_item_id
         ${where} ORDER BY rr.created_at DESC LIMIT $${status ? 2 : 1} OFFSET $${status ? 3 : 2}`,
        params
      );
      res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUT /api/v1/loyalty/redemptions/:id/approve
  app.put('/api/v1/loyalty/redemptions/:id/approve', auth, async (req, res) => {
    try {
      const redemption = await pool.query('SELECT * FROM redemption_requests WHERE id = $1', [req.params.id]);
      if (!redemption.rows.length) return res.status(404).json({ error: 'Not found' });
      if (redemption.rows[0].status !== 'pending') return res.status(400).json({ error: 'Not in pending status' });
  
      await pool.query(
        `UPDATE redemption_requests SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=$2`,
        [req.user.id, req.params.id]
      );
  
      // Send WhatsApp notification
      try {
        const farmer = await pool.query('SELECT phone, name FROM farmers WHERE id = $1', [redemption.rows[0].farmer_id]);
        const item = await pool.query('SELECT name FROM redemption_catalog WHERE id = $1', [redemption.rows[0].catalog_item_id]);
        if (farmer.rows.length) {
          await axios.post('https://vartmap-whatsapp-gateway.onrender.com/api/v1/send-message', {
            phone: farmer.rows[0].phone,
            message: `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° Hi ${farmer.rows[0].name}! Your redemption request for "${item.rows[0]?.name}" has been approved! We'll process it shortly. Ref: ${req.params.id.slice(0,8)}`
          });
        }
      } catch (e) { console.log('WhatsApp notification failed:', e.message); }
  
      res.json({ success: true, message: 'Redemption approved' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUT /api/v1/loyalty/redemptions/:id/deliver
  app.put('/api/v1/loyalty/redemptions/:id/deliver', auth, async (req, res) => {
    try {
      const { tracking_number, notes } = req.body;
      await pool.query(
        `UPDATE redemption_requests SET status='delivered', delivered_at=NOW(), tracking_number=$1, notes=$2 WHERE id=$3`,
        [tracking_number, notes, req.params.id]
      );
      res.json({ success: true, message: 'Marked as delivered' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUT /api/v1/loyalty/redemptions/:id/reject
  app.put('/api/v1/loyalty/redemptions/:id/reject', auth, async (req, res) => {
    try {
      const { reason } = req.body;
      const redemption = await pool.query('SELECT * FROM redemption_requests WHERE id = $1', [req.params.id]);
      if (!redemption.rows.length) return res.status(404).json({ error: 'Not found' });
  
      // Refund points
      const farmer = await pool.query('SELECT loyalty_points FROM farmers WHERE id = $1', [redemption.rows[0].farmer_id]);
      const refundedBalance = (farmer.rows[0]?.loyalty_points || 0) + redemption.rows[0].points_spent;
      await pool.query('UPDATE farmers SET loyalty_points = $1 WHERE id = $2', [refundedBalance, redemption.rows[0].farmer_id]);
  
      await pool.query(
        `INSERT INTO loyalty_transactions (farmer_id, type, points, balance_after, source, source_id, description)
         VALUES ($1, 'earn', $2, $3, 'refund', $4, $5)`,
        [redemption.rows[0].farmer_id, redemption.rows[0].points_spent, refundedBalance, req.params.id, 'Redemption rejected: ' + (reason || 'No reason')]
      );
  
      await pool.query(
        `UPDATE redemption_requests SET status='rejected', rejection_reason=$1 WHERE id=$2`,
        [reason, req.params.id]
      );
  
      res.json({ success: true, message: 'Redemption rejected, points refunded' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/loyalty/leaderboard - Top farmers by points
  app.get('/api/v1/loyalty/leaderboard', auth, async (req, res) => {
    try {
      const { limit = 20 } = req.query;
      const result = await pool.query(
        `SELECT f.id, f.name, f.phone, f.village, f.loyalty_points, f.lifetime_points,
                lt.name as tier_name, lt.icon as tier_icon, lt.color as tier_color
         FROM farmers f LEFT JOIN loyalty_tiers lt ON lt.id = f.loyalty_tier_id
         WHERE f.lifetime_points > 0 ORDER BY f.lifetime_points DESC LIMIT $1`,
        [limit]
      );
      res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUBLIC: Farmer loyalty status (no auth)
  app.get('/api/v1/public/loyalty/:phone', async (req, res) => {
    try {
      const phone = req.params.phone.replace(/\D/g, '');
      const fullPhone = phone.length === 10 ? '91' + phone : phone;
      const farmer = await pool.query(
        `SELECT f.id, f.name, f.phone, f.loyalty_points, f.lifetime_points,
                lt.name as tier_name, lt.icon as tier_icon, lt.color as tier_color, lt.benefits
         FROM farmers f LEFT JOIN loyalty_tiers lt ON lt.id = f.loyalty_tier_id
         WHERE f.phone = $1 OR f.phone = $2`,
        [phone, fullPhone]
      );
      if (!farmer.rows.length) return res.status(404).json({ error: 'Farmer not found' });
  
      const transactions = await pool.query(
        'SELECT type, points, balance_after, source, description, created_at FROM loyalty_transactions WHERE farmer_id = $1 ORDER BY created_at DESC LIMIT 20',
        [farmer.rows[0].id]
      );
  
      const catalog = await pool.query('SELECT id, name, description, category, points_required, redemption_type FROM redemption_catalog WHERE active = true ORDER BY sort_order');
  
      res.json({
        farmer: farmer.rows[0],
        transactions: transactions.rows,
        catalog: catalog.rows
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUBLIC: Farmer redeem points (no auth, phone-verified)
  app.post('/api/v1/public/loyalty/redeem', async (req, res) => {
    try {
      const { phone, catalog_item_id, delivery_address } = req.body;
      if (!phone || !catalog_item_id) return res.status(400).json({ error: 'phone and catalog_item_id required' });
  
      const cleanPhone = phone.replace(/\D/g, '');
      const fullPhone = cleanPhone.length === 10 ? '91' + cleanPhone : cleanPhone;
      const farmer = await pool.query('SELECT id, name, phone, loyalty_points FROM farmers WHERE phone = $1 OR phone = $2', [cleanPhone, fullPhone]);
      if (!farmer.rows.length) return res.status(404).json({ error: 'Farmer not found' });
  
      const item = await pool.query('SELECT * FROM redemption_catalog WHERE id = $1 AND active = true', [catalog_item_id]);
      if (!item.rows.length) return res.status(404).json({ error: 'Item not found' });
      if (item.rows[0].stock !== -1 && item.rows[0].redeemed_count >= item.rows[0].stock) return res.status(400).json({ error: 'Out of stock' });
      if ((farmer.rows[0].loyalty_points || 0) < item.rows[0].points_required) return res.status(400).json({ error: 'Insufficient points' });
  
      const newBalance = farmer.rows[0].loyalty_points - item.rows[0].points_required;
      await pool.query('UPDATE farmers SET loyalty_points = $1 WHERE id = $2', [newBalance, farmer.rows[0].id]);
      await pool.query('UPDATE redemption_catalog SET redeemed_count = redeemed_count + 1 WHERE id = $1', [catalog_item_id]);
  
      await pool.query(
        `INSERT INTO loyalty_transactions (farmer_id, type, points, balance_after, source, description)
         VALUES ($1, 'redeem', $2, $3, 'redemption', $4)`,
        [farmer.rows[0].id, item.rows[0].points_required, newBalance, 'Redeemed: ' + item.rows[0].name]
      );
  
      const request = await pool.query(
        `INSERT INTO redemption_requests (farmer_id, catalog_item_id, points_spent, farmer_phone, delivery_address)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [farmer.rows[0].id, catalog_item_id, item.rows[0].points_required, fullPhone, delivery_address]
      );
  
      res.json({ success: true, redemption: request.rows[0], new_balance: newBalance });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
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
  // ---
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
  // GET /api/v1/coupons/:id - Get campaign details with all codes
  app.get('/api/v1/coupons/:id', auth, async (req, res) => {
    try {
      const campaign = await pool.query('SELECT * FROM coupon_campaigns WHERE id = $1', [req.params.id]);
      if (!campaign.rows.length) return res.status(404).json({ error: 'Campaign not found' });
      
      const codes = await pool.query(
        `SELECT cc.*, f.name as farmer_name, f.phone as farmer_phone 
         FROM coupon_codes cc LEFT JOIN farmers f ON f.id = cc.farmer_id 
         WHERE cc.campaign_id = $1 ORDER BY cc.created_at DESC`,
        [req.params.id]
      );
      
      const stats = await pool.query(
        `SELECT 
          COUNT(*) as total_codes,
          COUNT(CASE WHEN status = 'available' THEN 1 END) as available,
          COUNT(CASE WHEN status = 'used' THEN 1 END) as used,
          COUNT(CASE WHEN status = 'assigned' THEN 1 END) as assigned,
          COUNT(CASE WHEN status = 'expired' THEN 1 END) as expired
         FROM coupon_codes WHERE campaign_id = $1`,
        [req.params.id]
      );
      
      res.json({ campaign: campaign.rows[0], codes: codes.rows, stats: stats.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUT /api/v1/coupons/:id - Update campaign
  app.put('/api/v1/coupons/:id', auth, async (req, res) => {
    try {
      const { name, status, start_date, end_date, discount_type, discount_value, max_uses, min_purchase } = req.body;
      const result = await pool.query(
        `UPDATE coupon_campaigns SET name=COALESCE($1,name), status=COALESCE($2,status), 
         start_date=COALESCE($3,start_date), end_date=COALESCE($4,end_date),
         discount_type=COALESCE($5,discount_type), discount_value=COALESCE($6,discount_value),
         max_uses=COALESCE($7,max_uses), min_purchase=COALESCE($8,min_purchase), updated_at=NOW()
         WHERE id=$9 RETURNING *`,
        [name, status, start_date, end_date, discount_type, discount_value, max_uses, min_purchase, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // POST /api/v1/coupons/:id/generate - Generate more codes for existing campaign
  app.post('/api/v1/coupons/:id/generate', auth, async (req, res) => {
    try {
      const { count = 10 } = req.body;
      const campaign = await pool.query('SELECT * FROM coupon_campaigns WHERE id = $1', [req.params.id]);
      if (!campaign.rows.length) return res.status(404).json({ error: 'Campaign not found' });
      
      const prefix = campaign.rows[0].code_prefix || 'VART';
      const codes = [];
      for (let i = 0; i < Math.min(count, 1000); i++) {
        const code = prefix + crypto.randomBytes(4).toString('hex').toUpperCase();
        await pool.query('INSERT INTO coupon_codes (campaign_id, code, status) VALUES ($1, $2, $3)', 
          [req.params.id, code, 'available']);
        codes.push(code);
      }
      res.json({ generated: codes.length, codes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // POST /api/v1/coupons/validate - Validate a coupon code (public-facing)
  app.post('/api/v1/coupons/validate', async (req, res) => {
    try {
      const { code, phone } = req.body;
      if (!code) return res.status(400).json({ error: 'Code is required' });
      
      const coupon = await pool.query(
        `SELECT cc.*, cp.name as campaign_name, cp.discount_type, cp.discount_value, 
                cp.min_purchase, cp.status as campaign_status, cp.start_date, cp.end_date
         FROM coupon_codes cc JOIN coupon_campaigns cp ON cp.id = cc.campaign_id 
         WHERE cc.code = $1`,
        [code.toUpperCase()]
      );
      
      if (!coupon.rows.length) return res.status(404).json({ valid: false, error: 'Invalid coupon code' });
      
      const c = coupon.rows[0];
      if (c.status === 'used') return res.json({ valid: false, error: 'Coupon already used', used_at: c.used_at });
      if (c.status === 'expired') return res.json({ valid: false, error: 'Coupon has expired' });
      if (c.campaign_status !== 'active') return res.json({ valid: false, error: 'Campaign is not active' });
      if (c.end_date && new Date(c.end_date) < new Date()) return res.json({ valid: false, error: 'Campaign has ended' });
      if (c.start_date && new Date(c.start_date) > new Date()) return res.json({ valid: false, error: 'Campaign has not started yet' });
      
      res.json({
        valid: true,
        code: c.code,
        campaign: c.campaign_name,
        discount_type: c.discount_type,
        discount_value: c.discount_value,
        min_purchase: c.min_purchase
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // POST /api/v1/coupons/redeem - Redeem/use a coupon code
  app.post('/api/v1/coupons/redeem', async (req, res) => {
    try {
      const { code, phone, order_id } = req.body;
      if (!code || !phone) return res.status(400).json({ error: 'Code and phone are required' });
      
      const coupon = await pool.query(
        `SELECT cc.*, cp.discount_type, cp.discount_value, cp.name as campaign_name, cp.status as campaign_status
         FROM coupon_codes cc JOIN coupon_campaigns cp ON cp.id = cc.campaign_id 
         WHERE cc.code = $1`,
        [code.toUpperCase()]
      );
      
      if (!coupon.rows.length) return res.status(404).json({ error: 'Invalid coupon code' });
      const c = coupon.rows[0];
      if (c.status === 'used') return res.status(400).json({ error: 'Coupon already used' });
      if (c.campaign_status !== 'active') return res.status(400).json({ error: 'Campaign is not active' });
      
      // Find or note farmer
      const cleanPhone = phone.replace(/\D/g, '');
      const fullPhone = cleanPhone.length === 10 ? '91' + cleanPhone : cleanPhone;
      const farmer = await pool.query('SELECT id FROM farmers WHERE phone = $1 OR phone = $2', [cleanPhone, fullPhone]);
      const farmerId = farmer.rows.length ? farmer.rows[0].id : null;
      
      // Mark as used
      await pool.query(
        `UPDATE coupon_codes SET status = 'used', used_at = NOW(), farmer_id = $1, order_id = $2, 
         metadata = jsonb_set(COALESCE(metadata,'{}'), '{redeemed_phone}', $3::jsonb)
         WHERE id = $4`,
        [farmerId, order_id || null, JSON.stringify(fullPhone), c.id]
      );
      
      // Update campaign used count
      await pool.query('UPDATE coupon_campaigns SET used_count = used_count + 1 WHERE id = $1', [c.campaign_id]);
      
      // Award loyalty points if discount_type is 'points'
      if (c.discount_type === 'points' && farmerId) {
        const farmerData = await pool.query('SELECT loyalty_points FROM farmers WHERE id = $1', [farmerId]);
        const newBalance = (farmerData.rows[0]?.loyalty_points || 0) + c.discount_value;
        await pool.query('UPDATE farmers SET loyalty_points = $1, lifetime_points = COALESCE(lifetime_points,0) + $2 WHERE id = $3',
          [newBalance, c.discount_value, farmerId]);
        await pool.query(
          `INSERT INTO loyalty_transactions (farmer_id, type, points, balance_after, source, description)
           VALUES ($1, 'earn', $2, $3, 'coupon', $4)`,
          [farmerId, c.discount_value, newBalance, 'Coupon: ' + c.code]
        );
      }
      
      // Send WhatsApp confirmation
      try {
        await axios.post('https://vartmap-whatsapp-gateway.onrender.com/api/v1/send-message', {
          phone: fullPhone,
          message: `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ Coupon ${c.code} redeemed successfully!\n\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ${c.campaign_name}\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° ${c.discount_type === 'percentage' ? c.discount_value + '% discount' : c.discount_type === 'points' ? c.discount_value + ' loyalty points' : 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹' + c.discount_value + ' off'}\n\nThank you for your purchase! ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾`
        });
      } catch (e) { console.log('WhatsApp notification failed:', e.message); }
      
      res.json({ success: true, discount_type: c.discount_type, discount_value: c.discount_value, campaign: c.campaign_name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/coupons/:id/export - Export codes as CSV text
  app.get('/api/v1/coupons/:id/export', async (req, res) => {
    // Allow token via query param for CSV download
    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try { jwt.verify(token, process.env.JWT_SECRET || 'vartmap-secret-key-2026'); }
    catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
    try {
      const codes = await pool.query(
        `SELECT cc.code, cc.status, cc.used_at, f.name as farmer_name, f.phone as farmer_phone
         FROM coupon_codes cc LEFT JOIN farmers f ON f.id = cc.farmer_id 
         WHERE cc.campaign_id = $1 ORDER BY cc.code`,
        [req.params.id]
      );
      const csv = 'Code,Status,Used At,Farmer Name,Farmer Phone\n' +
        codes.rows.map(c => `${c.code},${c.status},${c.used_at || ''},${c.farmer_name || ''},${c.farmer_phone || ''}`).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=coupons-${req.params.id}.csv`);
      res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // DELETE /api/v1/coupons/:id - Delete a campaign and its codes
  app.delete('/api/v1/coupons/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM coupon_codes WHERE campaign_id = $1', [req.params.id]);
      await pool.query('DELETE FROM coupon_campaigns WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ==================== QR CODE GENERATION ====================
  // ---
  const QRCode = require('qrcode');
const XLSX = require('xlsx');
  
  // POST /api/v1/coupons/:id/generate-qr - Generate QR codes for all codes in a campaign
  app.post('/api/v1/coupons/:id/generate-qr', auth, async (req, res) => {
    try {
      const codes = await pool.query(
        'SELECT id, code FROM coupon_codes WHERE campaign_id = $1 AND qr_data_url IS NULL',
        [req.params.id]
      );
      if (!codes.rows.length) return res.json({ message: 'All codes already have QR codes', generated: 0 });
  
      let generated = 0;
      for (const code of codes.rows) {
        const qrDataUrl = await QRCode.toDataURL(code.code, { width: 300, margin: 2 });
        await pool.query('UPDATE coupon_codes SET qr_data_url = $1 WHERE id = $2', [qrDataUrl, code.id]);
        generated++;
      }
      res.json({ message: `Generated ${generated} QR codes`, generated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/coupons/:id/qr-sheet - Printable HTML sheet of QR codes
  app.get('/api/v1/coupons/:id/qr-sheet', async (req, res) => {
    try {
      const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      try { jwt.verify(token, process.env.JWT_SECRET || 'vartmap-secret-key-2026'); }
      catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
  
      const campaign = await pool.query('SELECT * FROM coupon_campaigns WHERE id = $1', [req.params.id]);
      if (!campaign.rows.length) return res.status(404).json({ error: 'Campaign not found' });
  
      const codes = await pool.query(
        'SELECT code, qr_data_url FROM coupon_codes WHERE campaign_id = $1 AND qr_data_url IS NOT NULL ORDER BY code',
        [req.params.id]
      );
      if (!codes.rows.length) return res.status(400).json({ error: 'No QR codes generated yet. Call generate-qr first.' });
  
      const camp = campaign.rows[0];
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>QR Codes - ${camp.name}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
          h1 { text-align: center; font-size: 18px; margin-bottom: 10px; }
          .info { text-align: center; font-size: 12px; color: #666; margin-bottom: 20px; }
          .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; }
          .card { border: 1px solid #ddd; border-radius: 8px; padding: 10px; text-align: center; page-break-inside: avoid; }
          .card img { width: 120px; height: 120px; }
          .card .code { font-family: monospace; font-size: 11px; font-weight: bold; margin-top: 5px; letter-spacing: 1px; }
          .card .campaign { font-size: 9px; color: #888; margin-top: 3px; }
          @media print { body { padding: 10px; } .grid { gap: 8px; } .card { padding: 6px; } .card img { width: 100px; height: 100px; } }
        </style>
      </head><body>
        <h1>${camp.name} - Coupon QR Codes</h1>
        <p class="info">${codes.rows.length} codes | Discount: ${camp.discount_type === 'percentage' ? camp.discount_value + '%' : camp.discount_type === 'points' ? camp.discount_value + ' pts' : 'Rs.' + camp.discount_value}</p>
        <div class="grid">
          ${codes.rows.map(c => `<div class="card"><img src="${c.qr_data_url}" /><div class="code">${c.code}</div><div class="campaign">${camp.name}</div></div>`).join('')}
        </div>
      </body></html>`;
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
  
  // POST /api/v1/coupons/:id/assign-dealer - Assign batch of codes to a dealer
  app.post('/api/v1/coupons/:id/assign-dealer', auth, async (req, res) => {
    try {
      const { dealer_name, dealer_phone, codes_count, notes } = req.body;
      if (!dealer_name || !codes_count) return res.status(400).json({ error: 'dealer_name and codes_count required' });
  
      const available = await pool.query(
        'SELECT id, code FROM coupon_codes WHERE campaign_id = $1 AND status = $2 AND assigned_dealer_id IS NULL ORDER BY created_at LIMIT $3',
        [req.params.id, 'available', codes_count]
      );
      if (available.rows.length < codes_count) {
        return res.status(400).json({ error: `Only ${available.rows.length} unassigned codes available` });
      }
  
      const codeIds = available.rows.map(c => c.id);
      const dealerId = require('crypto').randomUUID();
      await pool.query(
        'UPDATE coupon_codes SET assigned_dealer_id = $1 WHERE id = ANY($2)',
        [dealerId, codeIds]
      );
  
      const batch = await pool.query(
        `INSERT INTO coupon_dealer_batches (campaign_id, dealer_id, dealer_name, dealer_phone, codes_count, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.params.id, dealerId, dealer_name, dealer_phone || null, codes_count, notes || null]
      );
  
      // Send WhatsApp notification to dealer if phone provided
      if (dealer_phone) {
        try {
          const whatsappUrl = process.env.WHATSAPP_API_URL || 'https://vartmap-whatsapp.onrender.com';
          await fetch(`${whatsappUrl}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              phone: dealer_phone,
              message: `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â« VartMap Coupon Assignment\n\nDear ${dealer_name},\n${codes_count} coupon codes have been assigned to you.\n\nPlease distribute these to farmers along with product sales.\n\nThank you for your partnership!`
            })
          });
        } catch (e) { console.log('WhatsApp dealer notification failed:', e.message); }
      }
  
      res.json({
        batch: batch.rows[0],
        codes_assigned: available.rows.map(c => c.code),
        message: `${codes_count} codes assigned to ${dealer_name}`
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/coupons/:id/dealers - List dealer assignments
  app.get('/api/v1/coupons/:id/dealers', auth, async (req, res) => {
    try {
      const batches = await pool.query(
        `SELECT cdb.*, 
          (SELECT COUNT(*) FROM coupon_codes WHERE assigned_dealer_id = cdb.dealer_id AND status = 'used') as redeemed_count
         FROM coupon_dealer_batches cdb WHERE cdb.campaign_id = $1 ORDER BY cdb.assigned_at DESC`,
        [req.params.id]
      );
      res.json(batches.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
  
  // POST /api/v1/coupons/:id/distribute - Bulk WhatsApp distribution
  app.post('/api/v1/coupons/:id/distribute', auth, async (req, res) => {
    try {
      const { farmer_ids, message_template } = req.body;
      if (!farmer_ids || !farmer_ids.length) return res.status(400).json({ error: 'farmer_ids array required' });
  
      const available = await pool.query(
        'SELECT id, code FROM coupon_codes WHERE campaign_id = $1 AND status = $2 AND assigned_dealer_id IS NULL ORDER BY created_at LIMIT $3',
        [req.params.id, 'available', farmer_ids.length]
      );
      if (available.rows.length < farmer_ids.length) {
        return res.status(400).json({ error: `Only ${available.rows.length} codes available, need ${farmer_ids.length}` });
      }
  
      const campaign = await pool.query('SELECT name, discount_type, discount_value FROM coupon_campaigns WHERE id = $1', [req.params.id]);
      const camp = campaign.rows[0];
  
      const dist = await pool.query(
        `INSERT INTO coupon_distributions (campaign_id, channel, total_recipients, status)
         VALUES ($1, 'whatsapp', $2, 'in_progress') RETURNING *`,
        [req.params.id, farmer_ids.length]
      );
  
      const whatsappUrl = process.env.WHATSAPP_API_URL || 'https://vartmap-whatsapp.onrender.com';
      let sentCount = 0, failedCount = 0;
  
      for (let i = 0; i < farmer_ids.length; i++) {
        try {
          const farmer = await pool.query('SELECT id, phone, name FROM farmers WHERE id = $1', [farmer_ids[i]]);
          if (!farmer.rows.length) { failedCount++; continue; }
  
          const f = farmer.rows[0];
          const code = available.rows[i];
  
          await pool.query(
            "UPDATE coupon_codes SET distributed_via = 'whatsapp', distributed_at = NOW(), status = 'assigned' WHERE id = $1",
            [code.id]
          );
  
          const discountText = camp.discount_type === 'percentage' ? camp.discount_value + '% off' :
                               camp.discount_type === 'points' ? camp.discount_value + ' loyalty points' :
                               'Rs.' + camp.discount_value + ' off';
  
          const msg = message_template
            ? message_template.replace('{name}', f.name || 'Farmer').replace('{code}', code.code).replace('{discount}', discountText)
            : `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Namaste ${f.name || 'Farmer'}!\n\nYou have a special offer from VartMap:\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â« Code: *${code.code}*\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° Discount: ${discountText}\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ Campaign: ${camp.name}\n\nTo redeem, simply reply with your code or show it at your dealer.\n\nHappy farming! ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾`;
  
          await fetch(`${whatsappUrl}/api/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: f.phone, message: msg })
          });
          sentCount++;
        } catch (e) { failedCount++; console.log('Distribution failed for farmer:', farmer_ids[i], e.message); }
      }
  
      await pool.query(
        'UPDATE coupon_distributions SET sent_count = $1, failed_count = $2, status = $3, completed_at = NOW() WHERE id = $4',
        [sentCount, failedCount, 'completed', dist.rows[0].id]
      );
  
      res.json({ distribution_id: dist.rows[0].id, sent: sentCount, failed: failedCount, total: farmer_ids.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
  
  // POST /api/v1/coupons/redeem-geo - Redeem with location tracking
  app.post('/api/v1/coupons/redeem-geo', async (req, res) => {
    try {
      const { code, phone, lat, lng, location_name } = req.body;
      if (!code || !phone) return res.status(400).json({ error: 'code and phone required' });
  
      const codeResult = await pool.query(
        `SELECT cc.*, camp.name as campaign_name, camp.discount_type, camp.discount_value, camp.status as campaign_status,
                camp.start_date, camp.end_date
         FROM coupon_codes cc JOIN coupon_campaigns camp ON cc.campaign_id = camp.id
         WHERE cc.code = $1`, [code.toUpperCase()]
      );
      if (!codeResult.rows.length) return res.status(404).json({ error: 'Invalid coupon code', valid: false });
  
      const c = codeResult.rows[0];
      if (c.status === 'used') return res.status(400).json({ error: 'Code already used', valid: false });
      if (c.campaign_status !== 'active') return res.status(400).json({ error: 'Campaign is not active', valid: false });
      if (c.end_date && new Date(c.end_date) < new Date()) return res.status(400).json({ error: 'Campaign expired', valid: false });
  
      const farmer = await pool.query('SELECT id, name FROM farmers WHERE phone = $1', [phone]);
      const farmerId = farmer.rows.length ? farmer.rows[0].id : null;
      const farmerName = farmer.rows.length ? farmer.rows[0].name : 'Farmer';
  
      await pool.query(
        `UPDATE coupon_codes SET status = 'used', used_by = $1, used_at = NOW(),
         redeemed_lat = $2, redeemed_lng = $3, redeemed_location = $4 WHERE id = $5`,
        [farmerId, lat || null, lng || null, location_name || null, c.id]
      );
  
      // Award loyalty points if discount type is points
      if (c.discount_type === 'points' && farmerId) {
        await pool.query('UPDATE farmers SET loyalty_points = loyalty_points + $1, lifetime_points = lifetime_points + $1 WHERE id = $2',
          [c.discount_value, farmerId]);
        await pool.query(
          `INSERT INTO loyalty_transactions (id, farmer_id, type, points, source, description, created_at)
           VALUES (gen_random_uuid(), $1, 'earned', $2, 'coupon', $3, NOW())`,
          [farmerId, c.discount_value, 'Coupon: ' + code.toUpperCase()]
        );
      }
  
      // Send WhatsApp confirmation
      try {
        const whatsappUrl = process.env.WHATSAPP_API_URL || 'https://vartmap-whatsapp.onrender.com';
        const discountText = c.discount_type === 'percentage' ? c.discount_value + '% discount' :
                             c.discount_type === 'points' ? c.discount_value + ' loyalty points' :
                             'Rs.' + c.discount_value + ' discount';
        await fetch(`${whatsappUrl}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone,
            message: `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ Coupon Redeemed!\n\nHi ${farmerName}, your code *${code.toUpperCase()}* has been successfully redeemed.\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Reward: ${discountText}\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ Campaign: ${c.campaign_name}\n\nThank you for choosing VartMap! ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾`
          })
        });
      } catch (e) { console.log('WhatsApp redeem notification failed:', e.message); }
  
      res.json({
        valid: true, redeemed: true,
        discount_type: c.discount_type, discount_value: c.discount_value,
        campaign_name: c.campaign_name,
        message: `Code redeemed successfully`
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/coupons/:id/geo-stats - Geographic redemption statistics
  app.get('/api/v1/coupons/:id/geo-stats', auth, async (req, res) => {
    try {
      const locationStats = await pool.query(
        `SELECT redeemed_location, COUNT(*) as count
         FROM coupon_codes WHERE campaign_id = $1 AND status = 'used' AND redeemed_location IS NOT NULL
         GROUP BY redeemed_location ORDER BY count DESC`,
        [req.params.id]
      );
      const geoPoints = await pool.query(
        `SELECT cc.code, cc.redeemed_lat, cc.redeemed_lng, cc.redeemed_location, cc.used_at, f.name as farmer_name
         FROM coupon_codes cc LEFT JOIN farmers f ON cc.used_by = f.id
         WHERE cc.campaign_id = $1 AND cc.status = 'used' AND cc.redeemed_lat IS NOT NULL`,
        [req.params.id]
      );
      const totalRedeemed = await pool.query(
        "SELECT COUNT(*) as total FROM coupon_codes WHERE campaign_id = $1 AND status = 'used'",
        [req.params.id]
      );
      const geoRedeemed = await pool.query(
        "SELECT COUNT(*) as total FROM coupon_codes WHERE campaign_id = $1 AND status = 'used' AND redeemed_lat IS NOT NULL",
        [req.params.id]
      );
      res.json({
        total_redeemed: parseInt(totalRedeemed.rows[0].total),
        geo_tracked: parseInt(geoRedeemed.rows[0].total),
        locations: locationStats.rows,
        points: geoPoints.rows
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
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

  // Upload Excel from soilhealth.dac.gov.in
  app.post('/api/v1/soil-data/upload-excel', auth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      
      // Find header row (contains 'State' or 'District' or 'Block')
      let headerIdx = -1;
      for (let i = 0; i < Math.min(rawData.length, 10); i++) {
        const row = rawData[i].map(c => String(c).trim().toLowerCase());
        if (row.includes('state') || row.includes('district') || row.includes('block')) {
          headerIdx = i;
          break;
        }
      }
      if (headerIdx === -1) return res.status(400).json({ error: 'Could not find header row. Expected columns: State, District, Block' });
      
      const headers = rawData[headerIdx].map(h => String(h).trim());
      const dataRows = rawData.slice(headerIdx + 1).filter(r => r.some(c => c !== '' && c !== null));
      
      // Map column names to indices
      const col = (name) => headers.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
      const stateCol = col('state');
      const distCol = col('district');
      const blockCol = col('block');
      const cycleCol = col('cycle');
      
      // Nutrient columns - try exact match first
      const findCol = (primary, fallback) => {
        let idx = headers.findIndex(h => h === primary);
        if (idx === -1 && fallback) idx = headers.findIndex(h => h === fallback);
        if (idx === -1) idx = headers.findIndex(h => h.toLowerCase().includes(primary.toLowerCase()));
        return idx;
      };
      
      const nHigh = findCol('N_High');
      const nMed = findCol('N_Medium');
      const nLow = findCol('N_Low');
      const pHigh = findCol('P_High');
      const pMed = findCol('P_Medium');
      const pLow = findCol('P_Low');
      const kHigh = findCol('K_High');
      const kMed = findCol('K_Medium');
      const kLow = findCol('K_Low');
      const ocHigh = findCol('OC_High');
      const ocMed = findCol('OC_Medium');
      const ocLow = findCol('OC_Low');
      const phAlk = findCol('P H_Alkaline', 'PH_Alkaline');
      const phAcid = findCol('P H_Acidic', 'PH_Acidic');
      const phNeut = findCol('P H_Neutral', 'PH_Neutral');
      const ecNonSal = findCol('EC_Non Saline', 'EC_NonSaline');
      const ecSal = findCol('EC_Saline');
      const sSuff = findCol('S_Sufficient');
      const sDef = findCol('S_Deficient');
      const feSuff = findCol('Fe_Sufficient');
      const feDef = findCol('Fe_Deficient');
      const znSuff = findCol('Zn_Sufficient');
      const znDef = findCol('Zn_Deficient');
      const cuSuff = findCol('Cu_Sufficient');
      const cuDef = findCol('Cu_Deficient');
      const bSuff = findCol('B_Sufficient');
      const bDef = findCol('B_Deficient');
      const mnSuff = findCol('Mn_Sufficient');
      const mnDef = findCol('Mn_Deficient');
      
      const v = (row, idx) => idx >= 0 ? (parseFloat(row[idx]) || 0) : 0;
      const pct = (val, total) => total > 0 ? Math.round((val / total) * 10000) / 100 : 0;
      
      // Detect if data is already in percentages (values between 0-100 and sum ~100)
      let isPercentage = false;
      if (dataRows.length > 0 && nHigh >= 0 && nMed >= 0 && nLow >= 0) {
        const testRow = dataRows[0];
        const sum = v(testRow, nHigh) + v(testRow, nMed) + v(testRow, nLow);
        if (sum > 90 && sum < 110) isPercentage = true;
      }
      
      let inserted = 0;
      let skipped = 0;
      const errors = [];
      
      for (const row of dataRows) {
        try {
          const state = String(row[stateCol] || '').trim();
          const district = String(row[distCol] || '').trim();
          const block = String(row[blockCol] || '').trim();
          if (!district && !block) { skipped++; continue; }
          
          const cycleStr = cycleCol >= 0 ? String(row[cycleCol] || '') : '';
          const yearMatch = cycleStr.match(/(\d{4})/);
          const sampleYear = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();
          
          // Calculate totals and percentages
          const nTotal = v(row, nHigh) + v(row, nMed) + v(row, nLow);
          const pTotal = v(row, pHigh) + v(row, pMed) + v(row, pLow);
          const kTotal = v(row, kHigh) + v(row, kMed) + v(row, kLow);
          const ocTotal = v(row, ocHigh) + v(row, ocMed) + v(row, ocLow);
          const totalSamples = Math.max(nTotal, pTotal, kTotal, ocTotal);
          
          let nHP, nMP, nLP, pHP, pMP, pLP, kHP, kMP, kLP, ocHP, ocMP, ocLP;
          if (isPercentage) {
            nHP = v(row, nHigh); nMP = v(row, nMed); nLP = v(row, nLow);
            pHP = v(row, pHigh); pMP = v(row, pMed); pLP = v(row, pLow);
            kHP = v(row, kHigh); kMP = v(row, kMed); kLP = v(row, kLow);
            ocHP = v(row, ocHigh); ocMP = v(row, ocMed); ocLP = v(row, ocLow);
          } else {
            nHP = pct(v(row,nHigh),nTotal); nMP = pct(v(row,nMed),nTotal); nLP = pct(v(row,nLow),nTotal);
            pHP = pct(v(row,pHigh),pTotal); pMP = pct(v(row,pMed),pTotal); pLP = pct(v(row,pLow),pTotal);
            kHP = pct(v(row,kHigh),kTotal); kMP = pct(v(row,kMed),kTotal); kLP = pct(v(row,kLow),kTotal);
            ocHP = pct(v(row,ocHigh),ocTotal); ocMP = pct(v(row,ocMed),ocTotal); ocLP = pct(v(row,ocLow),ocTotal);
          }
          
          // pH: calculate weighted average (Alkaline=8.5, Neutral=7, Acidic=5.5)
          const phTotal = v(row,phAlk) + v(row,phAcid) + v(row,phNeut);
          const avgPh = phTotal > 0 ? Math.round(((v(row,phAlk)*8.5 + v(row,phNeut)*7 + v(row,phAcid)*5.5) / phTotal) * 100) / 100 : null;
          
          // EC: % saline
          const ecTotal = v(row,ecNonSal) + v(row,ecSal);
          const avgEc = ecTotal > 0 ? Math.round((v(row,ecSal) / ecTotal) * 10000) / 100 : 0;
          
          // Micronutrients: % sufficient
          const microPct = (suff, def) => { const t = v(row,suff)+v(row,def); return t>0 ? Math.round((v(row,suff)/t)*10000)/100 : null; };
          const avgS = microPct(sSuff, sDef);
          const avgFe = microPct(feSuff, feDef);
          const avgZn = microPct(znSuff, znDef);
          const avgCu = microPct(cuSuff, cuDef);
          const avgB = microPct(bSuff, bDef);
          const avgMn = microPct(mnSuff, mnDef);
          
          // pH breakdown percentages
          const phAlkPct = phTotal > 0 ? pct(v(row,phAlk), phTotal) : 0;
          const phAcidPct = phTotal > 0 ? pct(v(row,phAcid), phTotal) : 0;
          const phNeutPct = phTotal > 0 ? pct(v(row,phNeut), phTotal) : 0;
          
          // EC breakdown percentages
          const ecSalinePct = ecTotal > 0 ? pct(v(row,ecSal), ecTotal) : 0;
          const ecNonSalinePct = ecTotal > 0 ? pct(v(row,ecNonSal), ecTotal) : 0;
          
          // Micronutrient deficient percentages
          const microDefPct = (suff, def) => { const t = v(row,suff)+v(row,def); return t>0 ? Math.round((v(row,def)/t)*10000)/100 : 0; };
          const sDefPct = microDefPct(sSuff, sDef);
          const feDefPct = microDefPct(feSuff, feDef);
          const znDefPct = microDefPct(znSuff, znDef);
          const cuDefPct = microDefPct(cuSuff, cuDef);
          const bDefPct = microDefPct(bSuff, bDef);
          const mnDefPct = microDefPct(mnSuff, mnDef);
          
          // Generate recommendations
          const recs = {};
          if (nLP > 60) recs.nitrogen = 'Nitrogen deficiency is severe (' + nLP.toFixed(0) + '% low). Apply Urea or DAP. Use green manuring and include legumes in crop rotation.';
          else if (nLP > 40) recs.nitrogen = 'Moderate nitrogen deficiency (' + nLP.toFixed(0) + '% low). Apply balanced NPK fertilizers. Consider vermicompost.';
          if (pLP > 50) recs.phosphorus = 'Phosphorus is adequate in most areas. Maintain with SSP or DAP application.';
          if (pHP > 30) recs.phosphorus = 'Good phosphorus levels (' + pHP.toFixed(0) + '% high). Reduce P fertilizer to save costs.';
          if (kLP > 30) recs.potassium = 'Potassium deficiency detected (' + kLP.toFixed(0) + '% low). Apply MOP (Muriate of Potash).';
          if (ocLP > 60) recs.organic_carbon = 'Severe organic carbon deficiency (' + ocLP.toFixed(0) + '% low). Add FYM, compost, or crop residues. Avoid burning stubble.';
          else if (ocLP > 40) recs.organic_carbon = 'Moderate OC deficiency. Incorporate organic matter through green manuring and composting.';
          if (avgZn !== null && avgZn < 50) recs.zinc = 'Zinc deficiency widespread (' + (100-avgZn).toFixed(0) + '% deficient). Apply ZnSO4 @ 25 kg/ha.';
          if (avgB !== null && avgB < 50) recs.boron = 'Boron deficiency detected (' + (100-avgB).toFixed(0) + '% deficient). Apply Borax @ 10 kg/ha.';
          if (avgS !== null && avgS < 30) recs.sulphur = 'Severe sulphur deficiency (' + (100-avgS).toFixed(0) + '% deficient). Use Gypsum or SSP for sulphur.';
          
          // Determine soil type from pH
          let soilType = null;
          if (avgPh !== null) {
            if (avgPh > 8) soilType = 'Alkaline';
            else if (avgPh < 6) soilType = 'Acidic';
            else soilType = 'Neutral';
          }
          
          // Delete existing record for same district+block+year
          await pool.query(
            'DELETE FROM soil_nutrient_data WHERE UPPER(district_name)=$1 AND UPPER(block_name)=$2 AND sample_year=$3',
            [district.toUpperCase(), block.toUpperCase(), sampleYear]
          );
          
          await pool.query(
            `INSERT INTO soil_nutrient_data (state_name, district_name, block_name, sample_year, total_samples,
             nitrogen_low_pct, nitrogen_medium_pct, nitrogen_high_pct,
             phosphorus_low_pct, phosphorus_medium_pct, phosphorus_high_pct,
             potassium_low_pct, potassium_medium_pct, potassium_high_pct,
             organic_carbon_low_pct, organic_carbon_medium_pct, organic_carbon_high_pct,
             avg_ph, avg_ec, avg_sulphur, avg_iron, avg_zinc, avg_copper, avg_boron, avg_manganese,
             ph_alkaline_pct, ph_acidic_pct, ph_neutral_pct,
             ec_saline_pct, ec_non_saline_pct,
             sulphur_sufficient_pct, sulphur_deficient_pct,
             iron_sufficient_pct, iron_deficient_pct,
             zinc_sufficient_pct, zinc_deficient_pct,
             copper_sufficient_pct, copper_deficient_pct,
             boron_sufficient_pct, boron_deficient_pct,
             manganese_sufficient_pct, manganese_deficient_pct,
             soil_type, scheme_name, cycle, recommendations, source, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48)`,
            [state || 'UTTAR PRADESH', district, block, sampleYear, isPercentage ? 0 : Math.round(totalSamples),
             nLP, nMP, nHP, pLP, pMP, pHP, kLP, kMP, kHP, ocLP, ocMP, ocHP,
             avgPh, avgEc, avgS, avgFe, avgZn, avgCu, avgB, avgMn,
             phAlkPct, phAcidPct, phNeutPct,
             ecSalinePct, ecNonSalinePct,
             avgS || 0, sDefPct,
             avgFe || 0, feDefPct,
             avgZn || 0, znDefPct,
             avgCu || 0, cuDefPct,
             avgB || 0, bDefPct,
             avgMn || 0, mnDefPct,
             soilType, row[headers.findIndex(h => h.toLowerCase().includes('scheme'))] || 'Soil Health Card RKVY',
             cycleStr, JSON.stringify(recs), 'soilhealth.dac.gov.in',
             JSON.stringify({ cycle: cycleStr, upload_date: new Date().toISOString(), format: isPercentage ? 'percentage' : 'raw_count' })]
          );

          inserted++;
        } catch (rowErr) {
          skipped++;
          errors.push(rowErr.message);
        }
      }
      
      res.json({ 
        success: true,
        inserted, 
        skipped, 
        total_rows: dataRows.length,
        format_detected: isPercentage ? 'percentage' : 'raw_count',
        errors: errors.slice(0, 10),
        debug: {
          headerIdx,
          headers: headers.slice(0, 10),
          columns: { stateCol, distCol, blockCol, cycleCol, nHigh, nMed, nLow, pHigh, pMed, pLow },
          first_data_row: dataRows.length ? dataRows[0].slice(0, 10).map(c => String(c)) : [],
          raw_rows_count: rawData.length
        }
      });
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
  
  // ---
  app.get('/api/v1/rewards', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT r.*, f.name as farmer_name, f.phone FROM rewards r LEFT JOIN farmers f ON r.farmer_id=$1f.id ORDER BY r.created_at DESC LIMIT 100');
      const stats = await pool.query("SELECT COUNT(*) as total, COALESCE(SUM(points),0) as total_points, COUNT(CASE WHEN status='earned' THEN 1 END) as pending FROM rewards");
      res.json({ rewards: r.rows, stats: stats.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.post('/api/v1/rewards', auth, async (req, res) => {
    try {
      const { farmer_id, type, points, description } = req.body;
      if (!farmer_id || !points) return res.status(400).json({ error: 'farmer_id and points required' });
      const r = await pool.query(
        `INSERT INTO rewards (farmer_id, type, points, description, status) VALUES ($1,$2,$3,$4,'earned') RETURNING *`,
        [farmer_id, type || 'bonus', points, description]
      );
      const setting = await pool.query("SELECT value FROM app_settings WHERE key='reward_loyalty_enabled'");
      if (!setting.rows.length || setting.rows[0].value === 'true') {
        await pool.query('UPDATE farmers SET loyalty_points = COALESCE(loyalty_points,0) + $1, lifetime_points = COALESCE(lifetime_points,0) + $1 WHERE id = $2', [points, farmer_id]);
        await pool.query("INSERT INTO loyalty_transactions (farmer_id, type, points, balance_after, source, description) VALUES ($1, 'earn', $2, (SELECT COALESCE(loyalty_points,0) FROM farmers WHERE id=$1), 'reward', $3)", [farmer_id, points, description || 'Admin reward: ' + (type || 'bonus')]);
      }
      res.json({ reward: r.rows[0], loyalty_updated: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
  app.get('/api/v1/referrals', auth, async (req, res) => {
    try {
      const codes = await pool.query('SELECT rc.*, f.name as farmer_name, f.phone FROM referral_codes rc LEFT JOIN farmers f ON rc.farmer_id=$1f.id ORDER BY rc.created_at DESC');
      const refs = await pool.query('SELECT r.*, f1.name as referrer_name, f2.name as referee_name FROM referrals r LEFT JOIN farmers f1 ON r.referrer_id=f1.id LEFT JOIN farmers f2 ON r.referee_id=f2.id ORDER BY r.created_at DESC LIMIT 100');
      res.json({ codes: codes.rows, referrals: refs.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
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
  
  // ---
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
  
  // ---
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
  
  // ---
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
  
  // ---
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
  
  // ---
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
  
  // ---
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
  
  // ---
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
  
  // ---
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
  
  // PUBLIC: Log AI usage from gateway (no auth needed - called by gateway)
  app.post('/api/v1/public/usage/log', async (req, res) => {
    try {
      const { farmer_id, feature, model, input_tokens, output_tokens, cost_inr, session_id } = req.body;
      await pool.query(
        `INSERT INTO usage_tracking (id, farmer_id, feature, model, input_tokens, output_tokens, cost_inr, session_id, created_at) 
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW())`,
        [farmer_id || null, feature || 'ai_chat', model || 'unknown', input_tokens || 0, output_tokens || 0, cost_inr || 0, session_id || null]
      );
      res.json({ logged: true });
    } catch (e) {
      // Table might not have all columns - try minimal insert
      try {
        await pool.query(
          'INSERT INTO usage_tracking (feature, cost_inr, created_at) VALUES ($1, $2, NOW())',
          [req.body.feature || 'ai_chat', req.body.cost_inr || 0]
        );
        res.json({ logged: true, minimal: true });
      } catch (e2) {
        res.status(500).json({ error: e2.message });
      }
    }
  });
  // TEMPORARY: Migrate usage_tracking table (remove after running once)
  /*app.post('/api/v1/public/migrate-usage', async (req, res) => {
    try {
      await pool.query(`
        ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
        ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS farmer_id UUID;
        ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS model VARCHAR(100);
        ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0;
        ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0;
        ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS session_id UUID;
      `);
      res.json({ migrated: true });
    } catch (e) {
      // Try one by one if batch fails
      const cols = [
        "ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid()",
        "ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS farmer_id UUID",
        "ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS model VARCHAR(100)",
        "ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0",
        "ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0",
        "ALTER TABLE usage_tracking ADD COLUMN IF NOT EXISTS session_id UUID"
      ];
      const results = [];
      for (const sql of cols) {
        try { await pool.query(sql); results.push('OK'); } catch (e2) { results.push(e2.message); }
      }
      res.json({ results });
    }
  });*/
  
  
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
  
  // ---
  // ADVANCED ANALYTICS ENDPOINTS
  // ---
  
  // GET /api/v1/analytics/campaigns ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Campaign performance summary
  app.get('/api/v1/analytics/campaigns', auth, async (req, res) => {
    try {
      const { days = 30 } = req.query;
      
      // Overall campaign stats
      const overview = await pool.query(`
        SELECT 
          COUNT(*) as total_campaigns,
          COUNT(*) FILTER (WHERE status='completed') as completed,
          COUNT(*) FILTER (WHERE status='active' OR status='sending') as active,
          COALESCE(SUM(sent_count),0) as total_sent,
          COALESCE(SUM(delivered_count),0) as total_delivered,
          COALESCE(SUM(read_count),0) as total_read,
          COALESCE(SUM(total_cost),0) as total_cost
        FROM campaigns WHERE created_at > NOW() - INTERVAL '1 day' * $1
      `, [days]);
  
      // Per-campaign breakdown
      const campaigns = await pool.query(`
        SELECT c.id, c.name, c.status, c.sent_count, c.delivered_count, c.read_count,
          c.total_cost, c.created_at, c.sent_at,
          t.name as template_name, t.wa_template_name,
          CASE WHEN c.sent_count > 0 THEN ROUND(c.delivered_count::numeric/c.sent_count*100,1) ELSE 0 END as delivery_rate,
          CASE WHEN c.delivered_count > 0 THEN ROUND(c.read_count::numeric/c.delivered_count*100,1) ELSE 0 END as read_rate,
          (SELECT COUNT(*) FROM campaign_messages WHERE campaign_id=c.id AND status='failed') as failed_count
        FROM campaigns c
        LEFT JOIN message_templates t ON c.template_id=t.id
        WHERE c.created_at > NOW() - INTERVAL '1 day' * $1
        ORDER BY c.created_at DESC
      `, [days]);
  
      // Daily send volume (for chart)
      const daily = await pool.query(`
        SELECT DATE(sent_at) as date, 
          COUNT(*) as sent,
          COUNT(*) FILTER (WHERE status='delivered' OR status='read') as delivered,
          COUNT(*) FILTER (WHERE status='read') as read,
          COUNT(*) FILTER (WHERE status='failed') as failed
        FROM campaign_messages
        WHERE sent_at > NOW() - INTERVAL '1 day' * $1
        GROUP BY DATE(sent_at)
        ORDER BY date
      `, [days]);
  
      res.json({
        overview: overview.rows[0],
        campaigns: campaigns.rows,
        daily_trend: daily.rows
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/analytics/farmers ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Farmer engagement analytics
  app.get('/api/v1/analytics/farmers', auth, async (req, res) => {
    try {
      const { days = 30 } = req.query;
  
      // Engagement tier distribution
      const tiers = await pool.query(`
        SELECT 
          CASE 
            WHEN updated_at < NOW() - INTERVAL '90 days' OR updated_at IS NULL THEN 'inactive'
            WHEN updated_at < NOW() - INTERVAL '30 days' THEN 'low'
            WHEN updated_at < NOW() - INTERVAL '7 days' THEN 'medium'
            ELSE 'high'
          END as tier,
          COUNT(*) as count
        FROM farmers WHERE status='active'
        GROUP BY tier
      `);
  
      // Farmer growth trend
      const growth = await pool.query(`
        SELECT DATE(created_at) as date, COUNT(*) as new_farmers,
          SUM(COUNT(*)) OVER (ORDER BY DATE(created_at)) as cumulative
        FROM farmers
        WHERE created_at > NOW() - INTERVAL '1 day' * $1
        GROUP BY DATE(created_at)
        ORDER BY date
      `, [days]);
  
      // Top engaged farmers
      const topFarmers = await pool.query(`
        SELECT f.id, f.name, f.phone, f.village, f.crops,
          COUNT(wm.id) as total_messages,
          MAX(wm.created_at) as last_active,
          COUNT(cm.id) FILTER (WHERE cm.status='read') as campaigns_read
        FROM farmers f
        LEFT JOIN wa_messages wm ON f.id=wm.farmer_id AND wm.created_at > NOW() - INTERVAL '1 day' * $1
        LEFT JOIN campaign_messages cm ON f.id=cm.farmer_id AND cm.sent_at > NOW() - INTERVAL '1 day' * $1
        WHERE f.status='active'
        GROUP BY f.id, f.name, f.phone, f.village, f.crops
        ORDER BY total_messages DESC
        LIMIT 20
      `, [days]);
  
      // By crop
      const byCrop = await pool.query(`
        SELECT UNNEST(string_to_array(COALESCE(crops::text,'unknown'),',')) as crop, 
          COUNT(DISTINCT f.id) as farmer_count
        FROM farmers f WHERE f.status='active'
        GROUP BY crop ORDER BY farmer_count DESC LIMIT 15
      `);
  
      // By district
      const byDistrict = await pool.query(`
        SELECT COALESCE(d.district_name,'Unknown') as district, 
          COALESCE(d.state_name,'Unknown') as state,
          COUNT(f.id) as farmer_count
        FROM farmers f
        LEFT JOIN districts_master d ON f.district_id=d.id
        WHERE f.status='active'
        GROUP BY d.district_name, d.state_name
        ORDER BY farmer_count DESC LIMIT 20
      `);
  
      // By language
      const byLanguage = await pool.query(`
        SELECT COALESCE(language,'unknown') as language, COUNT(*) as count
        FROM farmers WHERE status='active'
        GROUP BY language ORDER BY count DESC
      `);
  
      res.json({
        tiers: tiers.rows,
        growth: growth.rows,
        top_farmers: topFarmers.rows,
        by_crop: byCrop.rows,
        by_district: byDistrict.rows,
        by_language: byLanguage.rows
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/analytics/templates ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Template performance comparison
  app.get('/api/v1/analytics/templates', auth, async (req, res) => {
    try {
      const templates = await pool.query(`
        SELECT t.id, t.name, t.wa_template_name, t.category, t.language, t.status,
          COALESCE(tp.total_sent,
            (SELECT COUNT(*) FROM campaign_messages cm 
             JOIN campaigns c ON cm.campaign_id=c.id 
             WHERE c.template_id=t.id)) as total_sent,
          COALESCE(tp.total_delivered,
            (SELECT COUNT(*) FROM campaign_messages cm 
             JOIN campaigns c ON cm.campaign_id=c.id 
             WHERE c.template_id=t.id AND cm.status IN ('delivered','read'))) as total_delivered,
          COALESCE(tp.total_read,
            (SELECT COUNT(*) FROM campaign_messages cm 
             JOIN campaigns c ON cm.campaign_id=c.id 
             WHERE c.template_id=t.id AND cm.status='read')) as total_read,
          COALESCE(tp.total_failed,
            (SELECT COUNT(*) FROM campaign_messages cm 
             JOIN campaigns c ON cm.campaign_id=c.id 
             WHERE c.template_id=t.id AND cm.status='failed')) as total_failed
        FROM message_templates t
        LEFT JOIN template_performance tp ON t.id=tp.template_id
        ORDER BY total_sent DESC
      `);
  
      res.json({ templates: templates.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/analytics/geographic ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â District-level engagement heatmap data
  app.get('/api/v1/analytics/geographic', auth, async (req, res) => {
    try {
      const geo = await pool.query(`
        SELECT d.district_name as district, d.state_name as state,
          COUNT(DISTINCT f.id) as farmers,
          COUNT(DISTINCT cm.id) as messages_sent,
          COUNT(DISTINCT cm.id) FILTER (WHERE cm.status='read') as messages_read,
          COUNT(DISTINCT cm.id) FILTER (WHERE cm.status='delivered' OR cm.status='read') as messages_delivered,
          CASE WHEN COUNT(DISTINCT cm.id) > 0 
            THEN ROUND(COUNT(DISTINCT cm.id) FILTER (WHERE cm.status='read')::numeric / COUNT(DISTINCT cm.id) * 100, 1)
            ELSE 0 END as engagement_rate
        FROM farmers f
        LEFT JOIN districts_master d ON f.district_id=d.id
        LEFT JOIN campaign_messages cm ON f.id=cm.farmer_id
        WHERE f.status='active'
        GROUP BY d.district_name, d.state_name
        ORDER BY farmers DESC
      `);
  
      res.json({ regions: geo.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/analytics/conversations ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â WhatsApp conversation analytics
  app.get('/api/v1/analytics/conversations', auth, async (req, res) => {
    try {
      const { days = 30 } = req.query;
  
      const overview = await pool.query(`
        SELECT 
          COUNT(DISTINCT session_id) as total_sessions,
          COUNT(*) as total_messages,
          COUNT(*) FILTER (WHERE direction='inbound') as inbound,
          COUNT(*) FILTER (WHERE direction='outbound') as outbound,
          COUNT(DISTINCT farmer_id) as unique_farmers,
          ROUND(AVG(CASE WHEN direction='inbound' THEN 1 ELSE 0 END)::numeric * 100, 1) as farmer_initiation_pct
        FROM wa_messages
        WHERE created_at > NOW() - INTERVAL '1 day' * $1
      `, [days]);
  
      // Hourly distribution (best time to send)
      const hourly = await pool.query(`
        SELECT EXTRACT(HOUR FROM created_at)::int as hour,
          COUNT(*) FILTER (WHERE direction='inbound') as inbound,
          COUNT(*) FILTER (WHERE direction='outbound') as outbound
        FROM wa_messages
        WHERE created_at > NOW() - INTERVAL '1 day' * $1
        GROUP BY hour ORDER BY hour
      `, [days]);
  
      // Daily volume
      const daily = await pool.query(`
        SELECT DATE(created_at) as date,
          COUNT(*) FILTER (WHERE direction='inbound') as inbound,
          COUNT(*) FILTER (WHERE direction='outbound') as outbound,
          COUNT(DISTINCT farmer_id) as active_farmers
        FROM wa_messages
        WHERE created_at > NOW() - INTERVAL '1 day' * $1
        GROUP BY DATE(created_at) ORDER BY date
      `, [days]);
  
      // Top message types
      const msgTypes = await pool.query(`
        SELECT message_type, COUNT(*) as count
        FROM wa_messages
        WHERE created_at > NOW() - INTERVAL '1 day' * $1
        GROUP BY message_type ORDER BY count DESC
      `, [days]);
  
      res.json({
        overview: overview.rows[0],
        hourly: hourly.rows,
        daily: daily.rows,
        message_types: msgTypes.rows
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // POST /api/v1/analytics/refresh-engagement ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Recalculate farmer engagement scores
  app.post('/api/v1/analytics/refresh-engagement', auth, async (req, res) => {
    try {
      await pool.query(`
        INSERT INTO farmer_engagement_scores (farmer_id, total_messages_received, total_messages_sent, 
          total_campaigns_received, campaigns_read, last_message_at, response_rate, engagement_score, engagement_tier, updated_at)
        SELECT f.id,
          COALESCE((SELECT COUNT(*) FROM wa_messages WHERE farmer_id=f.id AND direction='outbound'), 0),
          COALESCE((SELECT COUNT(*) FROM wa_messages WHERE farmer_id=f.id AND direction='inbound'), 0),
          COALESCE((SELECT COUNT(*) FROM campaign_messages WHERE farmer_id=f.id), 0),
          COALESCE((SELECT COUNT(*) FROM campaign_messages WHERE farmer_id=f.id AND status='read'), 0),
          (SELECT MAX(created_at) FROM wa_messages WHERE farmer_id=f.id),
          CASE WHEN (SELECT COUNT(*) FROM wa_messages WHERE farmer_id=f.id AND direction='outbound') > 0
            THEN ROUND((SELECT COUNT(*) FROM wa_messages WHERE farmer_id=f.id AND direction='inbound')::numeric / 
                 (SELECT COUNT(*) FROM wa_messages WHERE farmer_id=f.id AND direction='outbound') * 100, 1)
            ELSE 0 END,
          LEAST(100, (
            COALESCE((SELECT COUNT(*) FROM wa_messages WHERE farmer_id=f.id AND direction='inbound'), 0) * 5 +
            COALESCE((SELECT COUNT(*) FROM campaign_messages WHERE farmer_id=f.id AND status='read'), 0) * 10 +
            CASE WHEN (SELECT MAX(created_at) FROM wa_messages WHERE farmer_id=f.id) > NOW() - INTERVAL '7 days' THEN 30 ELSE 0 END +
            CASE WHEN (SELECT MAX(created_at) FROM wa_messages WHERE farmer_id=f.id) > NOW() - INTERVAL '30 days' THEN 15 ELSE 0 END
          )),
          CASE 
            WHEN LEAST(100, (COALESCE((SELECT COUNT(*) FROM wa_messages WHERE farmer_id=f.id AND direction='inbound'), 0) * 5 +
              COALESCE((SELECT COUNT(*) FROM campaign_messages WHERE farmer_id=f.id AND status='read'), 0) * 10 +
              CASE WHEN (SELECT MAX(created_at) FROM wa_messages WHERE farmer_id=f.id) > NOW() - INTERVAL '7 days' THEN 30 ELSE 0 END +
              CASE WHEN (SELECT MAX(created_at) FROM wa_messages WHERE farmer_id=f.id) > NOW() - INTERVAL '30 days' THEN 15 ELSE 0 END)) >= 70 THEN 'super'
            WHEN LEAST(100, (COALESCE((SELECT COUNT(*) FROM wa_messages WHERE farmer_id=f.id AND direction='inbound'), 0) * 5 +
              COALESCE((SELECT COUNT(*) FROM campaign_messages WHERE farmer_id=f.id AND status='read'), 0) * 10 +
              CASE WHEN (SELECT MAX(created_at) FROM wa_messages WHERE farmer_id=f.id) > NOW() - INTERVAL '7 days' THEN 30 ELSE 0 END +
              CASE WHEN (SELECT MAX(created_at) FROM wa_messages WHERE farmer_id=f.id) > NOW() - INTERVAL '30 days' THEN 15 ELSE 0 END)) >= 40 THEN 'high'
            WHEN LEAST(100, (COALESCE((SELECT COUNT(*) FROM wa_messages WHERE farmer_id=f.id AND direction='inbound'), 0) * 5 +
              COALESCE((SELECT COUNT(*) FROM campaign_messages WHERE farmer_id=f.id AND status='read'), 0) * 10 +
              CASE WHEN (SELECT MAX(created_at) FROM wa_messages WHERE farmer_id=f.id) > NOW() - INTERVAL '7 days' THEN 30 ELSE 0 END +
              CASE WHEN (SELECT MAX(created_at) FROM wa_messages WHERE farmer_id=f.id) > NOW() - INTERVAL '30 days' THEN 15 ELSE 0 END)) >= 15 THEN 'medium'
            ELSE 'low'
          END,
          NOW()
        FROM farmers f WHERE f.status='active'
        ON CONFLICT (farmer_id) DO UPDATE SET
          total_messages_received = EXCLUDED.total_messages_received,
          total_messages_sent = EXCLUDED.total_messages_sent,
          total_campaigns_received = EXCLUDED.total_campaigns_received,
          campaigns_read = EXCLUDED.campaigns_read,
          last_message_at = EXCLUDED.last_message_at,
          response_rate = EXCLUDED.response_rate,
          engagement_score = EXCLUDED.engagement_score,
          engagement_tier = EXCLUDED.engagement_tier,
          updated_at = NOW()
      `);
  
      const counts = await pool.query(`
        SELECT engagement_tier, COUNT(*) as count FROM farmer_engagement_scores GROUP BY engagement_tier
      `);
      res.json({ success: true, tiers: counts.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // GET /api/v1/analytics/roi ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Cost & ROI analytics
  app.get('/api/v1/analytics/roi', auth, async (req, res) => {
    try {
      const { days = 30 } = req.query;
      // WhatsApp conversation pricing (approximate INR rates)
      const WA_MARKETING_COST = 0.83;  // INR per marketing conversation
      const WA_UTILITY_COST = 0.35;    // INR per utility conversation
      
      const costs = await pool.query(`
        SELECT 
          COUNT(*) as total_messages,
          COUNT(*) FILTER (WHERE cm.status IN ('delivered','read')) as successful,
          COUNT(*) FILTER (WHERE cm.status='read') as read_messages,
          COUNT(DISTINCT cm.farmer_id) as farmers_reached,
          COUNT(DISTINCT c.id) as campaigns_used
        FROM campaign_messages cm
        JOIN campaigns c ON cm.campaign_id=c.id
        WHERE cm.sent_at > NOW() - INTERVAL '1 day' * $1
      `, [days]);
  
      const row = costs.rows[0];
      const estCost = (parseInt(row.total_messages) || 0) * WA_MARKETING_COST;
      const costPerRead = row.read_messages > 0 ? (estCost / parseInt(row.read_messages)).toFixed(2) : 0;
      const costPerFarmer = row.farmers_reached > 0 ? (estCost / parseInt(row.farmers_reached)).toFixed(2) : 0;
  
      res.json({
        ...row,
        estimated_cost_inr: estCost.toFixed(2),
        cost_per_read_inr: costPerRead,
        cost_per_farmer_reached_inr: costPerFarmer,
        wa_marketing_rate: WA_MARKETING_COST,
        wa_utility_rate: WA_UTILITY_COST
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  
  // ---
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
  
  // ---
  app.get('/api/v1/audit-log', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100');
      res.json({ logs: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
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
  // ---
  const axios = require('axios');
  // --- AGMARKNET 2.0 LIVE MANDI PRICES ---
  const AGMARKNET_API = 'https://api.agmarknet.gov.in/v1';
  const AGMARKNET_HEADERS = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': 'https://agmarknet.gov.in', 'Referer': 'https://agmarknet.gov.in/' };
  
  // Key commodity IDs from Agmarknet: {name: id}
  const MANDI_COMMODITIES = {
    'Rice': 3, 'Wheat': 1, 'Paddy(Common)': 2, 'Onion': 23, 'Potato': 24,
    'Tomato': 65, 'Sugarcane': 76, 'Maize': 5, 'Soyabean': 35,
    'Mustard': 19, 'Gram': 11, 'Arhar': 36, 'Urad': 37, 'Moong': 38,
    'Banana': 62, 'Apple': 60, 'Cotton': 48, 'Groundnut': 16,
    'Turmeric': 30, 'Chilli': 109, 'Garlic': 147, 'Ginger': 148
  };

  async function fetchAgmarknetPrices(commodityIds, date) {
    try {
      const dateStr = date || new Date().toISOString().split('T')[0];
      const resp = await axios.post(AGMARKNET_API + '/prices-and-arrivals/commodity-market/daily-report-weighted',
        { commodityIds, date: dateStr },
        { headers: AGMARKNET_HEADERS, timeout: 30000 }
      );
      if (!resp.data || !resp.data.success) return [];
      const rows = [];
      for (const grp of (resp.data.commodities || [])) {
        for (const item of (grp.items || [])) {
          const commodity = item.Commodity;
          for (const st of (item.states || [])) {
            const state = st.state;
            for (const mkt of (st.markets || [])) {
              for (const d of (mkt.data || [])) {
                if (d.modalPrice > 0) {
                  rows.push({
                    commodity, variety: d.variety || '', market_name: mkt.market_name || '',
                    district: '', state, min_price: d.minPrice || 0, max_price: d.maxPrice || 0,
                    modal_price: d.modalPrice || 0, unit: (d.unitOfPrice || 'Rs./Quintal').replace('Rs./', ''),
                    arrival_qty: d.arrivals || 0, price_date: dateStr, source: 'agmarknet.gov.in'
                  });
                }
              }
            }
          }
        }
      }
      return rows;
    } catch (e) { console.error('Agmarknet fetch error:', e.message); return []; }
  }

  async function syncMandiPrices(date) {
    const allIds = Object.values(MANDI_COMMODITIES);
    // Fetch in batches of 5 to avoid overloading
    let totalInserted = 0;
    for (let i = 0; i < allIds.length; i += 5) {
      const batch = allIds.slice(i, i + 5);
      const rows = await fetchAgmarknetPrices(batch, date);
      for (const r of rows) {
        try {
          await pool.query(
            `INSERT INTO mandi_prices (commodity, variety, market_name, district, state, min_price, max_price, modal_price, unit, arrival_qty, price_date, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT ON CONSTRAINT uq_mandi_price DO UPDATE SET min_price=EXCLUDED.min_price, max_price=EXCLUDED.max_price, modal_price=EXCLUDED.modal_price, arrival_qty=EXCLUDED.arrival_qty, source=EXCLUDED.source`,
            [r.commodity, r.variety, r.market_name, r.district, r.state, r.min_price, r.max_price, r.modal_price, r.unit, r.arrival_qty, r.price_date, r.source]
          );
          totalInserted++;
        } catch (e) { /* skip duplicates */ }
      }
    }
    // Clean old data (keep last 30 days)
    await pool.query(`DELETE FROM mandi_prices WHERE price_date < CURRENT_DATE - INTERVAL '30 days'`);
    return totalInserted;
  }

  // Manual trigger endpoint (replaces old INTEL_URL proxy)
  app.get('/api/v1/fetch-mandi-prices', auth, async (req, res) => {
    try {
      const date = req.query.date || new Date().toISOString().split('T')[0];
      const inserted = await syncMandiPrices(date);
      const latest = await pool.query('SELECT COUNT(*) as total, MAX(price_date) as latest FROM mandi_prices');
      res.json({ success: true, inserted, total: latest.rows[0].total, latest_date: latest.rows[0].latest, source: 'agmarknet.gov.in' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Auto-sync on server start (runs once, then every 6 hours)
  (async () => {
    try {
      const latest = await pool.query('SELECT MAX(price_date) as d FROM mandi_prices');
      const lastDate = latest.rows[0].d;
      const today = new Date().toISOString().split('T')[0];
      if (!lastDate || lastDate.toISOString().split('T')[0] < today) {
        console.log('[Mandi] Auto-syncing prices from Agmarknet...');
        const n = await syncMandiPrices(today);
        console.log(`[Mandi] Synced ${n} price records for ${today}`);
      }
    } catch (e) { console.error('[Mandi] Auto-sync error:', e.message); }
  })();
  setInterval(async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const n = await syncMandiPrices(today);
      if (n > 0) console.log(`[Mandi] Periodic sync: ${n} records for ${today}`);
    } catch (e) { console.error('[Mandi] Periodic sync error:', e.message); }
  }, 6 * 60 * 60 * 1000); // every 6 hours
  
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
  // ---
  
  // Get all spin results with filters
  app.get('/api/v1/prizes', auth, async (req, res) => {
    try {
      const { status, prize_type, wheel_id, limit = 100, offset = 0 } = req.query;
      let q = `SELECT sr.*, f.name as farmer_name, f.phone as farmer_phone, f.village,
               sw.name as wheel_name, sws.label as segment_label, sws.color as segment_color,
               au.name as approved_by_name
               FROM spin_results sr
               JOIN farmers f ON sr.farmer_id = f.id
               JOIN spin_wheels sw ON sr.wheel_id = sw.id
               LEFT JOIN spin_wheel_segments sws ON sr.segment_id = sws.id
               LEFT JOIN admin_users au ON sr.approved_by = au.id
               WHERE 1=1`;
      const p = [];
      if (status) { p.push(status); q += ` AND sr.status = $${p.length}`; }
      if (prize_type) { p.push(prize_type); q += ` AND sr.prize_type = $${p.length}`; }
      if (wheel_id) { p.push(wheel_id); q += ` AND sr.wheel_id = $${p.length}`; }
      q += ' ORDER BY sr.created_at DESC';
      p.push(+limit); q += ` LIMIT $${p.length}`;
      p.push(+offset); q += ` OFFSET $${p.length}`;
      const r = await pool.query(q, p);
  
      // Stats
      const stats = await pool.query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'won') as pending_approval,
          COUNT(*) FILTER (WHERE status = 'verified') as verified,
          COUNT(*) FILTER (WHERE status = 'paid' OR status = 'delivered') as fulfilled,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
          COUNT(*) FILTER (WHERE prize_type != 'better_luck') as total_winners,
          COALESCE(SUM(prize_value) FILTER (WHERE status = 'paid' OR status = 'delivered'), 0) as total_paid,
          COALESCE(SUM(prize_value) FILTER (WHERE status = 'won' OR status = 'verified'), 0) as total_pending
        FROM spin_results
      `);
  
      res.json({ prizes: r.rows, stats: stats.rows[0], limit: +limit, offset: +offset });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // Approve a prize
  app.put('/api/v1/prizes/:id/approve', auth, async (req, res) => {
    try {
      const { notes } = req.body;
      const prize = await pool.query('SELECT sr.*, f.phone, f.name as farmer_name FROM spin_results sr JOIN farmers f ON sr.farmer_id = f.id WHERE sr.id = $1', [req.params.id]);
      if (!prize.rows.length) return res.status(404).json({ error: 'Prize not found' });
  
      const p = prize.rows[0];
      if (p.status !== 'won') return res.status(400).json({ error: 'Can only approve prizes with status "won"' });
  
      let couponCode = null;
      let updateFields = `status = 'verified', approved_by = $1, approved_at = NOW(), notes = $2`;
      let updateValues = [req.user.id, notes || null];
  
      // Auto-generate discount coupon if prize_type is 'discount'
      if (p.prize_type === 'discount') {
        couponCode = 'VRTWIN' + crypto.randomBytes(4).toString('hex').toUpperCase();
        updateFields += `, coupon_code = $${updateValues.length + 1}`;
        updateValues.push(couponCode);
  
        // Store in coupon_codes table
        await pool.query(
          `INSERT INTO coupon_codes (id, code, farmer_id, status, metadata, created_at)
           VALUES (gen_random_uuid(), $1, $2, 'active', $3, NOW())`,
          [couponCode, p.farmer_id, JSON.stringify({ source: 'spin_wheel', prize_id: req.params.id, discount_percent: p.prize_value })]
        );
      }
  
      updateValues.push(req.params.id);
      await pool.query(
        `UPDATE spin_results SET ${updateFields} WHERE id = $${updateValues.length}`,
        updateValues
      );
  
      // Send WhatsApp notification
      try {
        const gatewayUrl = process.env.GATEWAY_URL || 'https://vartmap-whatsapp-gateway.onrender.com';
        let msg = '';
        if (p.prize_type === 'cash') {
          msg = `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ Prize Approved!\n\nHi ${p.farmer_name}, your cash prize of ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹${p.prize_value} from the lucky draw has been approved!\n\nPlease reply with your UPI ID (e.g. name@upi) to receive the payment.\n\nRef: ${p.verification_code || p.id.slice(0,8)}\n\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ VartMap Krishi Sahayak`;
        } else if (p.prize_type === 'discount') {
          msg = `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ Prize Approved!\n\nHi ${p.farmer_name}, you won a ${p.prize_value}% discount!\n\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â·ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Your Coupon Code: *${couponCode}*\n\nShow this code to your nearest dealer to avail the discount.\n\nRef: ${p.verification_code || p.id.slice(0,8)}\n\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ VartMap Krishi Sahayak`;
        } else if (p.prize_type === 'points') {
          msg = `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ Prize Approved!\n\nHi ${p.farmer_name}, ${p.prize_value} loyalty points have been added to your account!\n\nTotal points will be visible in your next interaction.\n\nRef: ${p.verification_code || p.id.slice(0,8)}\n\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ VartMap Krishi Sahayak`;
        }
        if (msg) await axios.post(`${gatewayUrl}/api/v1/send-message`, { phone: p.phone, message: msg });
      } catch(e) { console.error('Prize approval WhatsApp failed:', e.message); }
  
      res.json({ success: true, coupon_code: couponCode });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // Reject a prize
  app.put('/api/v1/prizes/:id/reject', auth, async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason) return res.status(400).json({ error: 'Rejection reason is required' });
  
      const prize = await pool.query('SELECT sr.*, f.phone, f.name as farmer_name FROM spin_results sr JOIN farmers f ON sr.farmer_id = f.id WHERE sr.id = $1', [req.params.id]);
      if (!prize.rows.length) return res.status(404).json({ error: 'Prize not found' });
  
      await pool.query(
        `UPDATE spin_results SET status = 'rejected', rejection_reason = $1, approved_by = $2, approved_at = NOW() WHERE id = $3`,
        [reason, req.user.id, req.params.id]
      );
  
      // Notify farmer
      try {
        const p = prize.rows[0];
        const gatewayUrl = process.env.GATEWAY_URL || 'https://vartmap-whatsapp-gateway.onrender.com';
        const msg = `Hi ${p.farmer_name}, unfortunately your prize claim could not be verified.\n\nReason: ${reason}\n\nPlease contact support for help.\n\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ VartMap Krishi Sahayak`;
        await axios.post(`${gatewayUrl}/api/v1/send-message`, { phone: p.phone, message: msg });
      } catch(e) { console.error('Prize rejection WhatsApp failed:', e.message); }
  
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // Mark prize as paid/delivered
  app.put('/api/v1/prizes/:id/pay', auth, async (req, res) => {
    try {
      const { payment_method, payment_reference, notes } = req.body;
  
      const prize = await pool.query('SELECT sr.*, f.phone, f.name as farmer_name FROM spin_results sr JOIN farmers f ON sr.farmer_id = f.id WHERE sr.id = $1', [req.params.id]);
      if (!prize.rows.length) return res.status(404).json({ error: 'Prize not found' });
  
      const p = prize.rows[0];
      const newStatus = (p.prize_type === 'cash') ? 'paid' : 'delivered';
  
      await pool.query(
        `UPDATE spin_results SET status = $1, payment_method = $2, payment_reference = $3, paid_at = NOW(), notes = COALESCE($4, notes) WHERE id = $5`,
        [newStatus, payment_method || 'manual', payment_reference || null, notes || null, req.params.id]
      );
  
      // Update spent budget
      if (p.prize_type === 'cash') {
        await pool.query('UPDATE spin_wheels SET spent_budget = COALESCE(spent_budget,0) + $1 WHERE id = $2', [p.prize_value, p.wheel_id]);
      }
  
      // Notify farmer
      try {
        const gatewayUrl = process.env.GATEWAY_URL || 'https://vartmap-whatsapp-gateway.onrender.com';
        let msg = '';
        if (p.prize_type === 'cash') {
          msg = `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° Payment Sent!\n\nHi ${p.farmer_name}, ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹${p.prize_value} has been sent to your account!\n\nMethod: ${payment_method || 'UPI'}\nRef: ${payment_reference || p.id.slice(0,8)}\n\nThank you for participating! ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ VartMap Krishi Sahayak`;
        } else {
          msg = `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Prize Delivered!\n\nHi ${p.farmer_name}, your prize "${p.prize_label || p.prize_type}" has been marked as delivered.\n\nRef: ${payment_reference || p.id.slice(0,8)}\n\nThank you! ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ VartMap Krishi Sahayak`;
        }
        await axios.post(`${gatewayUrl}/api/v1/send-message`, { phone: p.phone, message: msg });
      } catch(e) { console.error('Prize payment WhatsApp failed:', e.message); }
  
      res.json({ success: true, status: newStatus });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // Farmer prize history (public - by phone)
  app.get('/api/v1/public/prizes/:phone', async (req, res) => {
    try {
      const phone = req.params.phone.replace(/[^0-9]/g, '');
      const farmer = await pool.query('SELECT id, name, phone FROM farmers WHERE phone = $1', [phone]);
      if (!farmer.rows.length) return res.status(404).json({ error: 'Farmer not found' });
  
      const prizes = await pool.query(
        `SELECT sr.id, sr.prize_type, sr.prize_value, sr.prize_label, sr.status, sr.coupon_code,
                sr.payment_method, sr.payment_reference, sr.paid_at, sr.created_at, sr.verification_code,
                sw.name as wheel_name, sws.label as segment_label, sws.color
         FROM spin_results sr
         JOIN spin_wheels sw ON sr.wheel_id = sw.id
         LEFT JOIN spin_wheel_segments sws ON sr.segment_id = sws.id
         WHERE sr.farmer_id = $1 AND sr.prize_type != 'better_luck'
         ORDER BY sr.created_at DESC`,
        [farmer.rows[0].id]
      );
  
      res.json({
        farmer: { name: farmer.rows[0].name, phone: farmer.rows[0].phone },
        prizes: prizes.rows,
        total_won: prizes.rows.length,
        total_value: prizes.rows.reduce((sum, p) => sum + parseFloat(p.prize_value || 0), 0)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
  
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
      let farmer = await pool.query('SELECT * FROM farmers WHERE phone=$1 OR phone=$2', [cleanPhone, cleanPhone.startsWith(String.fromCharCode(43)) ? cleanPhone.slice(1) : String.fromCharCode(43) + cleanPhone]);
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
      
      // Verify coupon code (REQUIRED - one coupon = one spin)
      if (!coupon_code) return res.status(400).json({ error: "Coupon code is required to spin" });
      const coupon = await pool.query(
        "SELECT cc.*, camp.name as campaign_name FROM coupon_codes cc JOIN coupon_campaigns camp ON camp.id = cc.campaign_id WHERE UPPER(cc.code)=$1",
        [coupon_code.toUpperCase()]
      );
      if (!coupon.rows.length) return res.status(400).json({ error: "Invalid coupon code" });
      if (coupon.rows[0].status === "used") return res.status(400).json({ error: "This coupon code has already been used" });
      if (coupon.rows[0].status !== "available") return res.status(400).json({ error: "This coupon code is not active" });
      // Mark coupon as used
      await pool.query("UPDATE coupon_codes SET status='used', used_by=$1, used_at=NOW() WHERE id=$2", [farmerId, coupon.rows[0].id]);
      
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
        `INSERT INTO spin_results (id, wheel_id, farmer_id, segment_id, prize_type, prize_value, prize_label, verification_code, status, created_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [req.params.id, farmer_id, selectedSegment.id, selectedSegment.prize_type,
        selectedSegment.prize_value || 0,
        selectedSegment.label || selectedSegment.prize_description || null,
        'VRT-' + Date.now().toString(36).toUpperCase(),
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
          const msg = `ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° Congratulations! You won "${selectedSegment.label}" in the ${wheel.name} lucky draw!\n\nReference: ${refId}\nPrize will be credited within 24 hours.\n\nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ VartMap Krishi Sahayak`;
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
  
  // --- SETTINGS API ---
  app.get('/api/v1/settings', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM app_settings ORDER BY key');
      const settings = {};
      r.rows.forEach(s => { settings[s.key] = s.value; });
      res.json({ settings, rows: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.put('/api/v1/settings', auth, async (req, res) => {
    try {
      const updates = req.body;
      for (const [key, value] of Object.entries(updates)) {
        await pool.query(
          'INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
          [key, String(value)]
        );
      }
            await auditLog('settings.updated', 'settings', null, 'Updated settings', {type:'admin',id:req.user?.id||'unknown'}, 'warning', null);
      res.json({ message: 'Settings updated' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  
  // --- REFERRAL ENDPOINTS ---
  app.post('/api/v1/referrals/generate', auth, async (req, res) => {
    try {
      const { farmer_id } = req.body;
      if (!farmer_id) return res.status(400).json({ error: 'farmer_id required' });
      const farmer = await pool.query('SELECT * FROM farmers WHERE id=$1', [farmer_id]);
      if (!farmer.rows.length) return res.status(404).json({ error: 'Farmer not found' });
      const code = 'REF' + Math.random().toString(36).substring(2,9).toUpperCase();
      const existing = await pool.query('SELECT * FROM referral_codes WHERE farmer_id=$1 AND status=$2', [farmer_id, 'active']);
      if (existing.rows.length) return res.json({ code: existing.rows[0] });
      const r = await pool.query(
        'INSERT INTO referral_codes (id, farmer_id, code, max_uses, current_uses, status, created_at) VALUES (gen_random_uuid(), $1, $2, 5, 0, $3, NOW()) RETURNING *',
        [farmer_id, code, 'active']
      );
      res.json({ code: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.post('/api/v1/public/referrals/redeem', async (req, res) => {
    try {
      const { referral_code, name, phone } = req.body;
      if (!referral_code || !phone) return res.status(400).json({ error: 'referral_code and phone required' });
      const cleanPhone = phone.replace(/[^0-9]/g, '');
      const rc = await pool.query("SELECT rc.*, f.name as referrer_name, f.phone as referrer_phone FROM referral_codes rc JOIN farmers f ON f.id = rc.farmer_id WHERE UPPER(rc.code)=$1 AND rc.status='active'", [referral_code.toUpperCase()]);
      if (!rc.rows.length) return res.status(400).json({ error: 'Invalid or expired referral code' });
      if (rc.rows[0].current_uses >= rc.rows[0].max_uses) return res.status(400).json({ error: 'Referral code has reached max uses' });
      const existingFarmer = await pool.query('SELECT * FROM farmers WHERE phone=$1 OR phone=$2', [cleanPhone, cleanPhone.startsWith(String.fromCharCode(43)) ? cleanPhone.slice(1) : String.fromCharCode(43) + cleanPhone]);
      if (existingFarmer.rows.length) return res.status(400).json({ error: 'This phone number is already registered' });
      const settings = {};
      const s = await pool.query('SELECT * FROM app_settings');
      s.rows.forEach(r => { settings[r.key] = r.value; });
      const referrerBonus = parseInt(settings.referral_bonus_referrer || '50');
      const refereeBonus = parseInt(settings.referral_bonus_referee || '25');
      const newFarmer = await pool.query(
        "INSERT INTO farmers (id, name, phone, status, onboarding_stage, profile_complete, total_interactions, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'active', 'referred', false, 0, NOW(), NOW()) RETURNING *",
        [name || 'Unknown', cleanPhone]
      );
      await pool.query(
        'INSERT INTO referrals (id, referrer_id, referee_id, referral_code_id, status, referrer_points, referee_points, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())',
        [rc.rows[0].farmer_id, newFarmer.rows[0].id, rc.rows[0].id, 'completed', referrerBonus, refereeBonus]
      );
      await pool.query('UPDATE referral_codes SET current_uses = current_uses + 1, points_earned = points_earned + $1 WHERE id=$2', [referrerBonus, rc.rows[0].id]);
      await pool.query('UPDATE farmers SET loyalty_points = COALESCE(loyalty_points,0) + $1, lifetime_points = COALESCE(lifetime_points,0) + $1 WHERE id = $2', [referrerBonus, rc.rows[0].farmer_id]);
      await pool.query("INSERT INTO loyalty_transactions (farmer_id, type, points, balance_after, source, description) VALUES ($1, 'earn', $2, (SELECT COALESCE(loyalty_points,0) FROM farmers WHERE id=$1), 'referral', $3)", [rc.rows[0].farmer_id, referrerBonus, 'Referral bonus: ' + (name || cleanPhone) + ' joined']);
      await pool.query('UPDATE farmers SET loyalty_points = COALESCE(loyalty_points,0) + $1, lifetime_points = COALESCE(lifetime_points,0) + $1 WHERE id = $2', [refereeBonus, newFarmer.rows[0].id]);
      await pool.query("INSERT INTO loyalty_transactions (farmer_id, type, points, balance_after, source, description) VALUES ($1, 'earn', $2, (SELECT COALESCE(loyalty_points,0) FROM farmers WHERE id=$1), 'referral', 'Welcome bonus for joining via referral')", [newFarmer.rows[0].id, refereeBonus]);
      res.json({ message: 'Referral successful', referrer_points: referrerBonus, referee_points: refereeBonus, farmer: newFarmer.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.get('/api/v1/catalog/products', auth, async (req, res) => {
    try {
      const { search, category, active_only } = req.query;
      let q = 'SELECT * FROM brand_products WHERE 1=1';
      const p = [];
      if (search) { p.push('%' + search + '%'); q += ` AND (product_name ILIKE $${p.length} OR product_code ILIKE $${p.length} OR composition ILIKE $${p.length})`; }
      if (category) { p.push(category); q += ` AND category=$${p.length}`; }
      if (active_only === 'true') q += ' AND is_active=true';
      q += ' ORDER BY sort_order, product_name';
      const r = await pool.query(q, p);
      res.json({ products: r.rows, total: r.rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.get('/api/v1/catalog/products/:id', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM brand_products WHERE id=$1', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Product not found' });
      const recs = await pool.query('SELECT * FROM crop_recommendations WHERE product_id=$1 AND is_active=true ORDER BY priority DESC, crop_name, growth_stage', [req.params.id]);
      res.json({ product: r.rows[0], recommendations: recs.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.post('/api/v1/catalog/products', auth, async (req, res) => {
    try {
      const { brand_name, product_name, product_code, category, subcategory, composition, description, description_hi, target_crops, soil_types, application_stages, dosage_per_acre, dosage_details, benefits, benefits_hi, price_range, pack_sizes, image_url, sort_order } = req.body;
      if (!product_name) return res.status(400).json({ error: 'product_name required' });
      const r = await pool.query(
        `INSERT INTO brand_products (brand_name, product_name, product_code, category, subcategory, composition, description, description_hi, target_crops, soil_types, application_stages, dosage_per_acre, dosage_details, benefits, benefits_hi, price_range, pack_sizes, image_url, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [brand_name || 'Vartmaan Fertilizers', product_name, product_code, category || 'micronutrient', subcategory, composition, description, description_hi, target_crops || '{}', soil_types || '{}', application_stages || '{}', dosage_per_acre, dosage_details || '{}', benefits, benefits_hi, price_range, pack_sizes || '{}', image_url, sort_order || 0]
      );
      res.json({ product: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.put('/api/v1/catalog/products/:id', auth, async (req, res) => {
    try {
      const fields = req.body;
      const sets = []; const vals = []; let idx = 1;
      for (const [k, v] of Object.entries(fields)) {
        if (['id','created_at'].includes(k)) continue;
        sets.push(`${k}=$${idx}`);
        vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
        idx++;
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      sets.push(`updated_at=NOW()`);
      vals.push(req.params.id);
      const r = await pool.query(`UPDATE brand_products SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`, vals);
      if (!r.rows.length) return res.status(404).json({ error: 'Product not found' });
      res.json({ product: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.delete('/api/v1/catalog/products/:id', auth, async (req, res) => {
    try {
      await pool.query('UPDATE brand_products SET is_active=false WHERE id=$1', [req.params.id]);
      res.json({ message: 'Product deactivated' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
  
  app.get('/api/v1/catalog/recommendations', auth, async (req, res) => {
    try {
      const { crop, stage, product_id } = req.query;
      let q = `SELECT cr.*, bp.product_name, bp.product_code, bp.brand_name, bp.composition
               FROM crop_recommendations cr JOIN brand_products bp ON cr.product_id=bp.id WHERE cr.is_active=true`;
      const p = [];
      if (crop) { p.push(crop); q += ` AND cr.crop_name ILIKE $${p.length}`; }
      if (stage) { p.push('%' + stage + '%'); q += ` AND cr.growth_stage ILIKE $${p.length}`; }
      if (product_id) { p.push(product_id); q += ` AND cr.product_id=$${p.length}`; }
      q += ' ORDER BY cr.crop_name, cr.priority DESC';
      const r = await pool.query(q, p);
      res.json({ recommendations: r.rows, total: r.rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.post('/api/v1/catalog/recommendations', auth, async (req, res) => {
    try {
      const { crop_name, crop_name_hi, growth_stage, growth_stage_hi, days_range, soil_type, product_id, dosage, application_method, application_method_hi, notes, notes_hi, priority } = req.body;
      if (!crop_name || !growth_stage || !product_id || !dosage) return res.status(400).json({ error: 'crop_name, growth_stage, product_id, and dosage required' });
      const r = await pool.query(
        `INSERT INTO crop_recommendations (crop_name, crop_name_hi, growth_stage, growth_stage_hi, days_range, soil_type, product_id, dosage, application_method, application_method_hi, notes, notes_hi, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [crop_name, crop_name_hi, growth_stage, growth_stage_hi, days_range, soil_type, product_id, dosage, application_method, application_method_hi, notes, notes_hi, priority || 0]
      );
      res.json({ recommendation: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.put('/api/v1/catalog/recommendations/:id', auth, async (req, res) => {
    try {
      const fields = req.body;
      const sets = []; const vals = []; let idx = 1;
      for (const [k, v] of Object.entries(fields)) {
        if (['id','created_at'].includes(k)) continue;
        sets.push(`${k}=$${idx}`); vals.push(v); idx++;
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      vals.push(req.params.id);
      const r = await pool.query(`UPDATE crop_recommendations SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`, vals);
      if (!r.rows.length) return res.status(404).json({ error: 'Recommendation not found' });
      res.json({ recommendation: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.delete('/api/v1/catalog/recommendations/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM crop_recommendations WHERE id=$1', [req.params.id]);
      res.json({ message: 'Recommendation deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---
  
  app.get('/api/v1/catalog/ai-context', async (req, res) => {
    try {
      const products = await pool.query('SELECT product_name, product_code, brand_name, composition, description, description_hi, target_crops, dosage_per_acre, benefits, benefits_hi, image_url FROM brand_products WHERE is_active=true ORDER BY sort_order');
      const recommendations = await pool.query(`SELECT cr.crop_name, cr.crop_name_hi, cr.growth_stage, cr.growth_stage_hi, cr.days_range, cr.soil_type, cr.dosage, cr.application_method, cr.application_method_hi, cr.notes, cr.notes_hi, bp.product_name, bp.product_code, bp.composition
        FROM crop_recommendations cr JOIN brand_products bp ON cr.product_id=bp.id WHERE cr.is_active=true ORDER BY cr.crop_name, cr.priority DESC`);
      res.json({ brand: 'Vartmaan Fertilizers', company: 'RCG Agro Private Limited', products: products.rows, recommendations: recommendations.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // --- BOT CONFIGURATION ---
  
  app.get('/api/v1/bot/config', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM bot_config ORDER BY config_key');
      const config = {};
      r.rows.forEach(row => { config[row.config_key] = row.config_value; });
      res.json({ config, rows: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.put('/api/v1/bot/config/:key', auth, async (req, res) => {
    try {
      const { value } = req.body;
      const r = await pool.query('UPDATE bot_config SET config_value=$1, updated_at=NOW() WHERE config_key=$2 RETURNING *', [JSON.stringify(value), req.params.key]);
      if (!r.rows.length) return res.status(404).json({ error: 'Config key not found' });
      res.json({ config: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // --- BOT MENU ITEMS ---
  
  app.get('/api/v1/bot/menu', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM bot_menu_items ORDER BY sort_order');
      res.json({ items: r.rows, total: r.rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.post('/api/v1/bot/menu', auth, async (req, res) => {
    try {
      const { menu_key, emoji, title_hi, title_en, description_hi, description_en, action_type, action_value, flow_id, sort_order } = req.body;
      if (!menu_key || !title_hi || !title_en) return res.status(400).json({ error: 'menu_key, title_hi, title_en required' });
      const r = await pool.query(
        'INSERT INTO bot_menu_items (menu_key, emoji, title_hi, title_en, description_hi, description_en, action_type, action_value, flow_id, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [menu_key, emoji, title_hi, title_en, description_hi, description_en, action_type || 'ai_chat', action_value, flow_id, sort_order || 0]
      );
      res.json({ item: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.put('/api/v1/bot/menu/:id', auth, async (req, res) => {
    try {
      const fields = req.body;
      const sets = []; const vals = []; let idx = 1;
      for (const [k, v] of Object.entries(fields)) {
        if (['id','created_at'].includes(k)) continue;
        sets.push(k + '=$' + idx); vals.push(v); idx++;
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields' });
      vals.push(req.params.id);
      const r = await pool.query('UPDATE bot_menu_items SET ' + sets.join(',') + ' WHERE id=$' + idx + ' RETURNING *', vals);
      if (!r.rows.length) return res.status(404).json({ error: 'Item not found' });
      res.json({ item: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.delete('/api/v1/bot/menu/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM bot_menu_items WHERE id=$1', [req.params.id]);
      res.json({ message: 'Deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // --- BOT FLOWS ---
  
  app.get('/api/v1/bot/flows', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT f.*, (SELECT COUNT(*) FROM bot_flow_steps WHERE flow_id=f.id) as step_count FROM bot_flows f ORDER BY created_at DESC');
      res.json({ flows: r.rows, total: r.rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.get('/api/v1/bot/flows/:id', auth, async (req, res) => {
    try {
      const f = await pool.query('SELECT * FROM bot_flows WHERE id=$1', [req.params.id]);
      if (!f.rows.length) return res.status(404).json({ error: 'Flow not found' });
      const s = await pool.query('SELECT * FROM bot_flow_steps WHERE flow_id=$1 ORDER BY step_order', [req.params.id]);
      res.json({ flow: f.rows[0], steps: s.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.post('/api/v1/bot/flows', auth, async (req, res) => {
    try {
      const { name, description, trigger_keywords, trigger_menu_key } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const r = await pool.query(
        'INSERT INTO bot_flows (name, description, trigger_keywords, trigger_menu_key) VALUES ($1,$2,$3,$4) RETURNING *',
        [name, description, trigger_keywords || '{}', trigger_menu_key]
      );
      res.json({ flow: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.put('/api/v1/bot/flows/:id', auth, async (req, res) => {
    try {
      const { name, description, trigger_keywords, trigger_menu_key, is_active } = req.body;
      const r = await pool.query(
        'UPDATE bot_flows SET name=COALESCE($1,name), description=COALESCE($2,description), trigger_keywords=COALESCE($3,trigger_keywords), trigger_menu_key=COALESCE($4,trigger_menu_key), is_active=COALESCE($5,is_active), updated_at=NOW() WHERE id=$6 RETURNING *',
        [name, description, trigger_keywords, trigger_menu_key, is_active, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Flow not found' });
      res.json({ flow: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.delete('/api/v1/bot/flows/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM bot_flows WHERE id=$1', [req.params.id]);
      res.json({ message: 'Flow deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // --- BOT FLOW STEPS ---
  
  app.post('/api/v1/bot/flows/:flowId/steps', auth, async (req, res) => {
    try {
      const { step_order, message_hi, message_en, media_url, media_type, response_type, options, routing, save_response_as, trigger_ai, ai_context } = req.body;
      if (!step_order) return res.status(400).json({ error: 'step_order required' });
      const r = await pool.query(
        'INSERT INTO bot_flow_steps (flow_id, step_order, message_hi, message_en, media_url, media_type, response_type, options, routing, save_response_as, trigger_ai, ai_context) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [req.params.flowId, step_order, message_hi, message_en, media_url, media_type, response_type || 'free_text', JSON.stringify(options || []), JSON.stringify(routing || {}), save_response_as, trigger_ai || false, ai_context]
      );
      res.json({ step: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.put('/api/v1/bot/flows/steps/:id', auth, async (req, res) => {
    try {
      const fields = req.body;
      const sets = []; const vals = []; let idx = 1;
      for (const [k, v] of Object.entries(fields)) {
        if (['id','flow_id','created_at'].includes(k)) continue;
        sets.push(k + '=$' + idx);
        vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
        idx++;
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields' });
      vals.push(req.params.id);
      const r = await pool.query('UPDATE bot_flow_steps SET ' + sets.join(',') + ' WHERE id=$' + idx + ' RETURNING *', vals);
      if (!r.rows.length) return res.status(404).json({ error: 'Step not found' });
      res.json({ step: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.delete('/api/v1/bot/flows/steps/:id', auth, async (req, res) => {
    try {
      await pool.query('DELETE FROM bot_flow_steps WHERE id=$1', [req.params.id]);
      res.json({ message: 'Step deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Reorder flow steps
  app.put('/api/v1/bot/flows/:flowId/reorder', auth, async (req, res) => {
    try {
      const { steps } = req.body;
      if (!Array.isArray(steps)) return res.status(400).json({ error: 'steps array required' });
      for (const s of steps) {
        await pool.query('UPDATE bot_flow_steps SET step_order=$1, updated_at=NOW() WHERE id=$2 AND flow_id=$3', [s.step_order, s.id, req.params.flowId]);
      }
      res.json({ message: 'Reordered', count: steps.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Reorder flow steps
  app.put('/api/v1/bot/flows/:flowId/reorder', auth, async (req, res) => {
    try {
      const { steps } = req.body; // [{id, step_order}, ...]
      if (!Array.isArray(steps)) return res.status(400).json({ error: 'steps array required' });
      for (const s of steps) {
        await pool.query('UPDATE bot_flow_steps SET step_order=$1, updated_at=NOW() WHERE id=$2 AND flow_id=$3', [s.step_order, s.id, req.params.flowId]);
      }
      res.json({ message: 'Reordered', count: steps.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // --- KNOWLEDGE BASE ---
  
  app.get('/api/v1/knowledge', auth, async (req, res) => {
    try {
      const { category, search } = req.query;
      let q = 'SELECT * FROM knowledge_base WHERE is_active=true';
      const p = [];
      if (category) { p.push(category); q += ' AND category=$' + p.length; }
      if (search) { p.push('%' + search + '%'); q += ' AND (title ILIKE $' + p.length + ' OR content_text ILIKE $' + p.length + ')'; }
      q += ' ORDER BY created_at DESC';
      const r = await pool.query(q, p);
      res.json({ documents: r.rows, total: r.rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.get('/api/v1/knowledge/:id', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM knowledge_base WHERE id=$1', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Document not found' });
      res.json({ document: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // --- KNOWLEDGE FILE UPLOAD ---
  app.post('/api/v1/knowledge/upload', auth, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const { title, category, tags, language } = req.body;
      let extractedText = '';
      const mimeType = req.file.mimetype;
      const fileName = req.file.originalname;
  
      if (mimeType === 'application/pdf') {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(req.file.buffer);
        extractedText = data.text;
      } else if (mimeType === 'text/plain' || mimeType === 'text/csv') {
        extractedText = req.file.buffer.toString('utf-8');
      } else if (mimeType.startsWith('image/')) {
        extractedText = '[Image: ' + fileName + '] - Image uploaded. Add description manually or use AI to analyze.';
      } else if (mimeType.includes('word') || mimeType.includes('document')) {
        extractedText = req.file.buffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\t\u0900-\u097F]/g, ' ').replace(/\s+/g, ' ').trim();
      } else {
        extractedText = req.file.buffer.toString('utf-8');
      }
  
      // Sanitize: remove null bytes and non-UTF8 characters that PostgreSQL rejects
      extractedText = extractedText
        .replace(/\x00/g, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
        .replace(/[^\x20-\x7E\n\r\t\u0080-\uFFFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
  
      if (!extractedText || extractedText.length < 10) {
  
        return res.status(400).json({ error: 'Could not extract text from file. Try pasting content manually.' });
      }
  
      const chunks = [];
      const words = extractedText.split(/\s+/);
      for (let i = 0; i < words.length; i += 200) {
        chunks.push(words.slice(i, i + 200).join(' '));
      }
  
      const r = await pool.query(
        'INSERT INTO knowledge_base (title, category, content_text, content_chunks, tags, language, file_url, file_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [title || fileName, category || 'general', extractedText, JSON.stringify(chunks), tags ? '{' + tags.split(',').map(t => t.trim()).filter(t => t).join(',') + '}' : '{}', language || 'hi', fileName, mimeType]
      );
      res.json({ document: r.rows[0], extracted_chars: extractedText.length, chunks: chunks.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  
  app.post('/api/v1/knowledge', auth, async (req, res) => {
    try {
      const { title, category, content_text, tags, language, file_url, file_type } = req.body;
      if (!title || !content_text) return res.status(400).json({ error: 'title and content_text required' });
      const chunks = [];
      const words = content_text.split(/\s+/);
      for (let i = 0; i < words.length; i += 200) {
        chunks.push(words.slice(i, i + 200).join(' '));
      }
      const r = await pool.query(
        'INSERT INTO knowledge_base (title, category, content_text, content_chunks, tags, language, file_url, file_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [title, category || 'general', content_text, JSON.stringify(chunks), tags ? '{' + tags.split(',').map(t => t.trim()).filter(t => t).join(',') + '}' : '{}', language || 'hi', file_url, file_type]
      );
      res.json({ document: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.put('/api/v1/knowledge/:id', auth, async (req, res) => {
    try {
      const fields = req.body;
      if (fields.content_text) {
        const words = fields.content_text.split(/\s+/);
        const chunks = [];
        for (let i = 0; i < words.length; i += 200) {
          chunks.push(words.slice(i, i + 200).join(' '));
        }
        fields.content_chunks = JSON.stringify(chunks);
      }
      const sets = []; const vals = []; let idx = 1;
      for (const [k, v] of Object.entries(fields)) {
        if (['id','created_at'].includes(k)) continue;
        sets.push(k + '=$' + idx);
        vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
        idx++;
      }
      sets.push('updated_at=NOW()');
      vals.push(req.params.id);
      const r = await pool.query('UPDATE knowledge_base SET ' + sets.join(',') + ' WHERE id=$' + idx + ' RETURNING *', vals);
      if (!r.rows.length) return res.status(404).json({ error: 'Document not found' });
      res.json({ document: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.delete('/api/v1/knowledge/:id', auth, async (req, res) => {
    try {
      await pool.query('UPDATE knowledge_base SET is_active=false, updated_at=NOW() WHERE id=$1', [req.params.id]);
      res.json({ message: 'Document archived' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // --- BOT CONTEXT (for WhatsApp gateway) ---
  
  app.get('/api/v1/bot/context', async (req, res) => {
    try {
      const config = await pool.query('SELECT * FROM bot_config');
      const menu = await pool.query('SELECT * FROM bot_menu_items WHERE is_active=true ORDER BY sort_order');
      const flows = await pool.query('SELECT * FROM bot_flows WHERE is_active=true');
      const configObj = {};
      config.rows.forEach(row => { configObj[row.config_key] = row.config_value; });
      res.json({ config: configObj, menu: menu.rows, flows: flows.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  app.get('/api/v1/bot/knowledge-context', async (req, res) => {
    try {
      const { query, category } = req.query;
      let q = 'SELECT id, title, category, content_chunks, tags FROM knowledge_base WHERE is_active=true';
      const p = [];
      if (category) { p.push(category); q += ' AND category=$' + p.length; }
      if (query) { p.push('%' + query + '%'); q += ' AND (title ILIKE $' + p.length + ' OR content_text ILIKE $' + p.length + ')'; }
      q += ' LIMIT 5';
      const r = await pool.query(q, p);
      res.json({ documents: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUBLIC SETTINGS (for gateway rate limits - only exposes ai_ settings)
  app.get('/api/v1/public/settings', async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM app_settings WHERE key LIKE 'ai_%'");
      const settings = {};
      r.rows.forEach(s => { settings[s.key] = s.value; });
      res.json({ settings });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUBLIC: Mandi prices for WhatsApp bot
  app.get('/api/v1/public/mandi-prices', async (req, res) => {
    try {
      const { commodity, state, district, limit } = req.query;
      let q = 'SELECT * FROM mandi_prices WHERE 1=1';
      const p = [];
      if (commodity) { p.push('%' + commodity + '%'); q += ` AND commodity ILIKE $${p.length}`; }
      if (state) { p.push('%' + state + '%'); q += ` AND state ILIKE $${p.length}`; }
      if (district) { p.push('%' + district + '%'); q += ` AND district ILIKE $${p.length}`; }
      q += ' ORDER BY price_date DESC LIMIT ' + Math.min(parseInt(limit) || 10, 50);
      const r = await pool.query(q, p);
      res.json({ prices: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUBLIC: Government schemes for WhatsApp bot
  app.get('/api/v1/public/schemes', async (req, res) => {
    try {
      const { crop, state, level } = req.query;
      let q = "SELECT * FROM government_schemes WHERE status='active'";
      const p = [];
      if (level) { p.push(level); q += ` AND level=$${p.length}`; }
      if (state) { p.push('%' + state + '%'); q += ` AND (state_code ILIKE $${p.length} OR level='central')`; }
      q += ' ORDER BY name LIMIT 20';
      const r = await pool.query(q, p);
      res.json({ schemes: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // PUBLIC: Soil data for WhatsApp bot
  app.get('/api/v1/public/soil-data', async (req, res) => {
    try {
      const { state, district } = req.query;
      let q = 'SELECT * FROM soil_nutrient_data WHERE 1=1';
      const p = [];
      if (state) { p.push('%' + state + '%'); q += ` AND state_name ILIKE $${p.length}`; }
      if (district) { p.push('%' + district + '%'); q += ` AND district_name ILIKE $${p.length}`; }
      q += ' LIMIT 5';
      const r = await pool.query(q, p);
      res.json({ data: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  
  // --- PUBLIC BOT CONFIG (for whatsapp-gateway, no auth) ---
  app.get('/api/v1/public/bot/config', async (req, res) => {
    try { const r = await pool.query('SELECT * FROM bot_config'); res.json({ config: r.rows }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/v1/public/bot/menu', async (req, res) => {
    try { const r = await pool.query('SELECT * FROM bot_menu_items WHERE is_active = true ORDER BY sort_order'); res.json({ items: r.rows }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/v1/public/bot/flows', async (req, res) => {
    try {
      const f = await pool.query('SELECT * FROM bot_flows WHERE is_active = true');
      const flows = [];
      for (const flow of f.rows) {
        const s = await pool.query('SELECT * FROM bot_flow_steps WHERE flow_id = $1 ORDER BY step_order', [flow.id]);
        flows.push({ ...flow, steps: s.rows });
      }
      res.json({ flows: flows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/v1/public/knowledge', async (req, res) => {
    try { const r = await pool.query("SELECT * FROM knowledge_base WHERE is_active = true"); res.json({ documents: r.rows }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // ---

  // ============================================================
  // FARMER MOBILE APP API ENDPOINTS
  // ============================================================

  // --- OTP Auth ---
  app.post('/api/v1/farmer/auth/send-otp', async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ error: 'Phone required' });

      const cleanPhone = phone.replace(/[^0-9+]/g, '');
      
      // Generate 4-digit OTP
      const otp = Math.floor(1000 + Math.random() * 9000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

      // Store OTP in database
      await pool.query(
        `INSERT INTO farmer_otps (phone, otp, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO UPDATE SET otp = $2, expires_at = $3, attempts = 0`,
        [cleanPhone, otp, expiresAt]
      );

      // Send OTP via WhatsApp (using existing gateway)
      try {
        const axios = require('axios');
        await axios.post('http://localhost:10000/api/v1/send-message', {
          phone: cleanPhone,
          message: `Your VartMap login OTP is: ${otp}\nValid for 5 minutes.\n\nआपका OTP है: ${otp}`
        });
      } catch (whatsappErr) {
        console.log('OTP WhatsApp send failed, OTP stored:', otp);
      }

      res.json({ success: true, message: 'OTP sent via WhatsApp' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/farmer/auth/verify-otp', async (req, res) => {
    try {
      const { phone, otp } = req.body;
      if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });

      const cleanPhone = phone.replace(/[^0-9+]/g, '');

      // Verify OTP
      const { rows } = await pool.query(
        `SELECT * FROM farmer_otps WHERE phone = $1 AND otp = $2 AND expires_at > NOW() AND attempts < 5`,
        [cleanPhone, otp]
      );

      if (!rows.length) {
        // Increment attempts
        await pool.query(`UPDATE farmer_otps SET attempts = attempts + 1 WHERE phone = $1`, [cleanPhone]);
        return res.status(401).json({ error: 'Invalid or expired OTP' });
      }

      // Delete used OTP
      await pool.query(`DELETE FROM farmer_otps WHERE phone = $1`, [cleanPhone]);

      // Find or create farmer
      let farmer;
      const { rows: existing } = await pool.query(`SELECT * FROM farmers WHERE phone = $1 OR phone = $2`, [cleanPhone, cleanPhone.startsWith(String.fromCharCode(43)) ? cleanPhone.slice(1) : String.fromCharCode(43) + cleanPhone]);
      
      if (existing.length) {
        farmer = existing[0];
      } else {
        const { rows: created } = await pool.query(
          `INSERT INTO farmers (phone, language, onboarding_stage) VALUES ($1, 'hi', 'registered') RETURNING *`,
          [cleanPhone]
        );
        farmer = created[0];
      }

      // Generate JWT token
      const jwt = require('jsonwebtoken');
      const secret = process.env.JWT_SECRET || 'vartmap-farmer-secret-2024';
      const token = jwt.sign({ id: farmer.id, phone: farmer.phone, role: 'farmer' }, secret, { expiresIn: '90d' });

      res.json({ token, farmer });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Farmer Auth Middleware ---
  function farmerAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const jwt = require('jsonwebtoken');
      const secret = process.env.JWT_SECRET || 'vartmap-farmer-secret-2024';
      const decoded = jwt.verify(authHeader.split(' ')[1], secret);
      if (decoded.role !== 'farmer') return res.status(403).json({ error: 'Not a farmer token' });
      req.farmer = decoded;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  // --- Profile ---
  app.get('/api/v1/farmer/profile', farmerAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM farmers WHERE id = $1`, [req.farmer.id]);
      if (!rows.length) return res.status(404).json({ error: 'Farmer not found' });
      res.json({ farmer: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/v1/farmer/profile', farmerAuth, async (req, res) => {
    try {
      const { name, village, crops, language, district, state, land_acres, pin_code } = req.body;
      const updates = []; const vals = [req.farmer.id]; let idx = 2;
      if (name) { updates.push('name = $' + idx); vals.push(name); idx++; }
      if (village) { updates.push('village = $' + idx); vals.push(village); idx++; }
      if (crops) { updates.push('crops = $' + idx); vals.push(Array.isArray(crops) ? '{' + crops.join(',') + '}' : crops); idx++; }
      if (language) { updates.push('language = $' + idx); vals.push(language); idx++; }
      if (land_acres) { updates.push('land_holding_acres = $' + idx); vals.push(land_acres); idx++; }
      if (pin_code) { updates.push('pin_code = $' + idx); vals.push(pin_code); idx++; }
      if (district || state) {
        const locObj = {};
        if (district) locObj.district = district;
        if (state) locObj.state = state;
        updates.push("location = COALESCE(location, '{}'::jsonb) || $" + idx + '::jsonb');
        vals.push(JSON.stringify(locObj)); idx++;
      }
      if (updates.length === 0) {
        const r = await pool.query('SELECT * FROM farmers WHERE id = $1', [req.farmer.id]);
        return res.json({ farmer: r.rows[0] });
      }
      updates.push('updated_at = NOW()');
      const result = await pool.query('UPDATE farmers SET ' + updates.join(', ') + ' WHERE id = $1 RETURNING *', vals);
      res.json({ farmer: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Dashboard ---
  app.get('/api/v1/farmer/dashboard', farmerAuth, async (req, res) => {
    try {
      const farmerId = req.farmer.id;
      const { rows: farmerRows } = await pool.query(`SELECT * FROM farmers WHERE id = $1`, [farmerId]);
      const farmer = farmerRows[0] || {};

      // Get loyalty points
      const { rows: loyaltyRows } = await pool.query(
        `SELECT COALESCE(SUM(points), 0) as total_points FROM loyalty_points WHERE farmer_id = $1`,
        [farmerId]
      );

      // Get unread messages count
      const { rows: msgRows } = await pool.query(
        `SELECT COUNT(*) as unread FROM wa_messages m
         JOIN wa_chat_sessions s ON m.session_id = s.id
         WHERE s.farmer_id = $1 AND m.direction = 'incoming' AND m.read = false`,
        [farmerId]
      );

      // Get active orders count
      let orderCount = 0;
      try {
        const { rows: orderRows } = await pool.query(
          `SELECT COUNT(*) as count FROM orders WHERE farmer_id = $1 AND status NOT IN ('delivered', 'cancelled')`,
          [farmerId]
        );
        orderCount = parseInt(orderRows[0]?.count || 0);
      } catch(e) {}

      res.json({
        farmer,
        points: parseInt(loyaltyRows[0]?.total_points || 0),
        tier: farmer.loyalty_tier || 'Bronze',
        unreadMessages: parseInt(msgRows[0]?.unread || 0),
        activeOrders: orderCount,
        greeting: `Welcome ${farmer.name || 'Farmer'}! Have a great day.`,
        weather: null,
        mandiPrices: [],
        tips: ['Keep soil moist during summer', 'Check for pest infestations weekly', 'Update your crop profile for better recommendations']
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Messages (synced with WhatsApp) ---
  app.get('/api/v1/farmer/messages', farmerAuth, async (req, res) => {
    try {
      const { limit = 50, before } = req.query;
      const farmerId = req.farmer.id;

      let query = `SELECT m.* FROM wa_messages m
        JOIN wa_chat_sessions s ON m.session_id = s.id
        WHERE s.farmer_id = $1`;
      const params = [farmerId];

      if (before) {
        query += ` AND m.created_at < $2`;
        params.push(before);
      }

      query += ` ORDER BY m.created_at ASC LIMIT $${params.length + 1}`;
      params.push(parseInt(limit));

      const { rows } = await pool.query(query, params);
      res.json({ messages: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/farmer/messages', farmerAuth, async (req, res) => {
    try {
      const { text, type = 'text' } = req.body;
      if (!text) return res.status(400).json({ error: 'Message text required' });

      const farmerId = req.farmer.id;
      const { rows: farmerRows } = await pool.query(`SELECT phone FROM farmers WHERE id = $1`, [farmerId]);
      if (!farmerRows.length) return res.status(404).json({ error: 'Farmer not found' });

      const phone = farmerRows[0].phone;

      // Find or create chat session
      let sessionId;
      const { rows: sessions } = await pool.query(
        `SELECT id FROM wa_chat_sessions WHERE farmer_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [farmerId]
      );

      if (sessions.length) {
        sessionId = sessions[0].id;
      } else {
        const { rows: newSession } = await pool.query(
          `INSERT INTO wa_chat_sessions (farmer_id, status) VALUES ($1, 'open') RETURNING id`,
          [farmerId]
        );
        sessionId = newSession[0].id;
      }

      // Store message as outgoing from farmer (direction = 'incoming' from admin perspective)
      const { rows: msg } = await pool.query(
        `INSERT INTO wa_messages (session_id, direction, body, msg_type, created_at)
         VALUES ($1, 'incoming', $2, $3, NOW()) RETURNING *`,
        [sessionId, text, type]
      );

      // Send via WhatsApp API so it appears in the actual WhatsApp chat
      try {
        const axios = require('axios');
        await axios.post('http://localhost:10000/api/v1/send-message', {
          to: phone,
          message: text
        });
      } catch (whatsappErr) {
        console.log('App message WhatsApp relay failed:', whatsappErr.message);
      }

      // Update session timestamp
      await pool.query(`UPDATE wa_chat_sessions SET last_message_at = NOW() WHERE id = $1`, [sessionId]);

      res.json({ message: msg[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Products ---
  app.get('/api/v1/farmer/products', farmerAuth, async (req, res) => {
    try {
      const { category } = req.query;
      let query = `SELECT * FROM brand_products WHERE is_active = true`;
      const params = [];
      if (category) { query += ` AND category = $1`; params.push(category); }
      query += ` ORDER BY created_at DESC`;
      const { rows } = await pool.query(query, params);
      res.json({ products: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/v1/farmer/products/:id', farmerAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM brand_products WHERE id = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Product not found' });
      res.json({ product: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Orders ---
  app.get('/api/v1/farmer/orders', farmerAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM orders WHERE farmer_id = $1 ORDER BY created_at DESC`,
        [req.farmer.id]
      );
      res.json({ orders: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/farmer/orders', farmerAuth, async (req, res) => {
    try {
      const { items, address } = req.body;
      if (!items || !items.length) return res.status(400).json({ error: 'Items required' });

      // Calculate total
      let total = 0;
      for (const item of items) {
        const { rows } = await pool.query(`SELECT price FROM products WHERE id = $1`, [item.product_id]);
        if (rows.length) total += rows[0].price * (item.quantity || 1);
      }

      const { rows } = await pool.query(
        `INSERT INTO orders (farmer_id, items, total, address, status, created_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW()) RETURNING *`,
        [req.farmer.id, JSON.stringify(items), total, address]
      );

      res.json({ order: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Loyalty & Rewards ---
  app.get('/api/v1/farmer/loyalty', farmerAuth, async (req, res) => {
    try {
      const farmerId = req.farmer.id;
      const { rows: points } = await pool.query(
        `SELECT COALESCE(SUM(points), 0) as total FROM loyalty_points WHERE farmer_id = $1`,
        [farmerId]
      );
      const { rows: history } = await pool.query(
        `SELECT * FROM loyalty_points WHERE farmer_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [farmerId]
      );
      const { rows: farmerRows } = await pool.query(`SELECT loyalty_tier FROM farmers WHERE id = $1`, [farmerId]);

      res.json({
        points: parseInt(points[0]?.total || 0),
        tier: farmerRows[0]?.loyalty_tier || 'Bronze',
        history: history
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/v1/farmer/coupons', farmerAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM coupons WHERE (farmer_id = $1 OR farmer_id IS NULL) AND expires_at > NOW() AND used = false ORDER BY created_at DESC`,
        [req.farmer.id]
      );
      res.json({ coupons: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/farmer/spin', farmerAuth, async (req, res) => {
    try {
      const farmerId = req.farmer.id;

      // Check if already spun today
      const { rows: spins } = await pool.query(
        `SELECT * FROM spin_history WHERE farmer_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [farmerId]
      );
      if (spins.length) return res.status(429).json({ error: 'Already spun today. Try again tomorrow!' });

      // Get active spin wheel
      const { rows: wheels } = await pool.query(`SELECT * FROM spin_wheels WHERE active = true LIMIT 1`);
      if (!wheels.length) return res.status(404).json({ error: 'No active spin wheel' });

      const wheel = wheels[0];
      const prizes = wheel.prizes || [];
      if (!prizes.length) return res.status(404).json({ error: 'No prizes configured' });

      // Weighted random selection
      const totalWeight = prizes.reduce((sum, p) => sum + (p.weight || 1), 0);
      let random = Math.random() * totalWeight;
      let prize = prizes[0];
      for (const p of prizes) {
        random -= (p.weight || 1);
        if (random <= 0) { prize = p; break; }
      }

      // Record spin
      await pool.query(
        `INSERT INTO spin_history (farmer_id, wheel_id, prize, created_at) VALUES ($1, $2, $3, NOW())`,
        [farmerId, wheel.id, JSON.stringify(prize)]
      );

      // Award points if prize is points
      if (prize.type === 'points' && prize.value) {
        await pool.query(
          `INSERT INTO loyalty_points (farmer_id, points, reason, created_at) VALUES ($1, $2, 'Spin wheel prize', NOW())`,
          [farmerId, prize.value]
        );
      }

      res.json({ prize });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Schemes ---
  app.get('/api/v1/farmer/schemes', farmerAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM government_schemes WHERE status = 'active' ORDER BY created_at DESC`);
      res.json({ schemes: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Mandi Prices ---
  app.get('/api/v1/farmer/mandi-prices', farmerAuth, async (req, res) => {
    try {
      const { district } = req.query;
      let query = `SELECT * FROM mandi_prices WHERE date >= NOW() - INTERVAL '3 days'`;
      const params = [];
      if (district) { query += ` AND district = $1`; params.push(district); }
      query += ` ORDER BY date DESC LIMIT 20`;
      const { rows } = await pool.query(query, params);
      res.json({ prices: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Push Token ---
  app.post('/api/v1/farmer/push-token', farmerAuth, async (req, res) => {
    try {
      const { token } = req.body;
      await pool.query(
        `UPDATE farmers SET push_token = $2, updated_at = NOW() WHERE id = $1`,
        [req.farmer.id, token]
      );
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  // ====== AI CHAT (Same RAG as WhatsApp bot) ======
  app.post('/api/v1/farmer/chat', farmerAuth, async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Message required' });

      const farmerId = req.farmer.id;
      const farmerData = await pool.query('SELECT * FROM farmers WHERE id = $1', [farmerId]);
      const farmer = farmerData.rows[0];

      // Build context with farmer info
      const context = `Farmer: ${farmer.name || 'Unknown'}, Crops: ${(farmer.crops || []).join(', ') || 'Not specified'}, Village: ${farmer.village || 'Unknown'}, District: ${farmer.district || 'Unknown'}`;

      // Route through gateway's AI endpoint (handles region/model issues)
      const axios = require('axios');
      let reply;
      try {
        const aiRes = await axios.post('http://localhost:10000/api/v1/farmer/ai-chat', { farmer_id: farmerId, message, context }, { timeout: 30000 });
        reply = aiRes.data.reply;
      } catch (aiErr) {
        // Fallback: use Groq
        const Groq = require('groq-sdk');
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const completion = await groq.chat.completions.create({
          messages: [
            { role: 'system', content: 'You are a helpful Indian farming assistant (Krishi Sahayak). Help farmers with crop advice, pest management, weather, government schemes, organic farming, market info. Answer in simple language. Mix Hindi and English if helpful. Keep answers concise. Farmer context: ' + context },
            { role: 'user', content: message }
          ],
          model: 'llama-3.3-70b-versatile',
          max_tokens: 1024,
        });
        reply = completion.choices[0].message.content;
      }

      // Store message in wa_messages for sync
      try {
        let session = await pool.query('SELECT id FROM wa_chat_sessions WHERE farmer_id = $1 AND status = $2', [farmerId, 'active']);
        if (!session.rows.length) {
          session = await pool.query("INSERT INTO wa_chat_sessions (id, farmer_id, status, last_message_at, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'active', NOW(), NOW(), NOW()) RETURNING *", [farmerId]);
        }
        const sessionId = session.rows[0].id;
        await pool.query("INSERT INTO wa_messages (id, session_id, farmer_id, direction, message_type, content, created_at) VALUES (gen_random_uuid(), $1, $2, 'inbound', 'text', $3, NOW())", [sessionId, farmerId, message]);
        await pool.query("INSERT INTO wa_messages (id, session_id, farmer_id, direction, message_type, content, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'text', $3, NOW())", [sessionId, farmerId, reply]);
      } catch (syncErr) { console.log('Chat sync error:', syncErr.message); }

      res.json({ reply });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ====== FASAL DOCTOR (Crop Disease Diagnosis) ======
  app.post('/api/v1/farmer/diagnose', farmerAuth, async (req, res) => {
    try {
      const { symptoms, image } = req.body;
      if (!symptoms && !image) return res.status(400).json({ error: 'Provide symptoms or image' });

      const Groq = require('groq-sdk');
      const groqAI = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const farmerId = req.farmer.id;
      const farmerData = await pool.query('SELECT crops, village FROM farmers WHERE id = $1', [farmerId]);
      const farmer = farmerData.rows[0] || {};

      let prompt = `You are an expert agricultural scientist and plant pathologist (Fasal Doctor). Diagnose the crop disease based on the information provided. Return your response as JSON with these fields: disease (name of disease), description (brief explanation), treatment (specific remedies and chemicals with dosage), prevention (how to prevent in future). Use simple language. Mix Hindi terms where common.

Farmer's crops: ${(farmer.crops || []).join(', ')}
Location: ${farmer.village || 'India'}

`;
      if (symptoms) {
        prompt += `Symptoms described: ${symptoms}`;
      }
      if (image) {
        prompt += `The farmer has uploaded an image of the affected crop. Based on common diseases, provide diagnosis. Symptoms from image analysis needed.`;
      }

      const completion = await groqAI.chat.completions.create({ messages: [{ role: 'user', content: prompt }], model: 'llama-3.3-70b-versatile', max_tokens: 1500 });
      let reply = completion.choices[0].message.content;

      // Try to parse as JSON
      try {
        reply = reply.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(reply);
        res.json(parsed);
      } catch (parseErr) {
        res.json({ disease: 'Analysis Complete', description: reply, treatment: 'Please consult a local agronomist for specific treatment.', prevention: 'Maintain crop hygiene and proper irrigation.' });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ====== MANDI PRICES ======
  app.post('/api/v1/farmer/mandi-prices', farmerAuth, async (req, res) => {
    try {
      const { crop, state, district } = req.body;

      // Try fetching from data.gov.in API
      const axios = require('axios');
      const commodity = (crop || 'Wheat').trim();
      const stateName = (state || 'Uttar Pradesh').trim();

      try {
        const apiUrl = `https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=${process.env.DATA_GOV_API_KEY || '579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b'}&format=json&limit=20&filters[commodity]=${encodeURIComponent(commodity)}&filters[state]=${encodeURIComponent(stateName)}`;
        const response = await axios.get(apiUrl, { timeout: 8000 });

        if (response.data && response.data.records && response.data.records.length > 0) {
          const prices = response.data.records.map((r) => ({
            market: r.market || r.district,
            commodity: r.commodity,
            min_price: r.min_price,
            max_price: r.max_price,
            modal_price: r.modal_price,
            date: r.arrival_date || new Date().toISOString().split('T')[0],
            district: r.district,
            state: r.state,
          }));
          return res.json({ prices, source: 'data.gov.in' });
        }
      } catch (apiErr) {
        console.log('Data.gov.in API error:', apiErr.message);
      }

      // Fallback: AI-generated estimate
      const Groq = require('groq-sdk');
      const groqAI = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const prompt = `Provide current estimated mandi prices for ${commodity} in ${stateName}${district ? ', ' + district : ''} in India. Return as JSON array with fields: market, commodity, min_price (number), max_price (number), modal_price (number), date (YYYY-MM-DD). Include 3-5 nearby mandis. Use realistic current prices in INR per quintal.`;

      const completion = await groqAI.chat.completions.create({ messages: [{ role: 'user', content: prompt }], model: 'llama-3.3-70b-versatile', max_tokens: 1500 });
      let reply = completion.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      try {
        const parsed = JSON.parse(reply);
        res.json({ prices: Array.isArray(parsed) ? parsed : parsed.prices || [], source: 'ai-estimate' });
      } catch (parseErr) {
        res.json({ prices: [], source: 'unavailable', message: 'Could not fetch prices' });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ====== DAILY TIP ======
  app.get('/api/v1/farmer/daily-tip', farmerAuth, async (req, res) => {
    try {
      const farmerId = req.farmer.id;
      const farmerData = await pool.query('SELECT crops, village FROM farmers WHERE id = $1', [farmerId]);
      const farmer = farmerData.rows[0] || {};

      const Groq = require('groq-sdk');
      const groqAI = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const month = new Date().toLocaleString('en-IN', { month: 'long' });
      const prompt = `Give one short actionable farming tip for the month of ${month} for a farmer growing ${(farmer.crops || ['general crops']).join(', ')} in ${farmer.village || 'North India'}. Keep it under 2 sentences. Mix Hindi words if natural.`;

      const completion = await groqAI.chat.completions.create({ messages: [{ role: 'user', content: prompt }], model: 'llama-3.3-70b-versatile', max_tokens: 200 });
      res.json({ tip: completion.choices[0].message.content });
    } catch (e) { res.json({ tip: 'Keep your fields well-irrigated and monitor for pests regularly.' }); }
  });

  // ====== WEATHER ======
  app.get('/api/v1/farmer/weather', farmerAuth, async (req, res) => {
    try {
      const farmerId = req.farmer.id;
      const farmerData = await pool.query('SELECT village, location FROM farmers WHERE id = $1', [farmerId]);
      const farmer = farmerData.rows[0] || {};
      const city = farmer.village || (farmer.location && farmer.location.district) || 'Delhi';

      const axios = require('axios');
      const weatherKey = process.env.OPENWEATHER_API_KEY || '';
      if (weatherKey) {
        const weatherRes = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)},IN&appid=${weatherKey}&units=metric`, { timeout: 5000 });
        const w = weatherRes.data;
        return res.json({
          temp: Math.round(w.main.temp),
          description: w.weather[0].description,
          humidity: w.main.humidity,
          wind: Math.round(w.wind.speed * 3.6),
          icon: w.weather[0].icon,
        });
      }
      res.json({ temp: null, description: 'Weather data unavailable', humidity: null, wind: null });
    } catch (e) { console.log('Weather error:', e.message, 'Key present:', !!process.env.OPENWEATHER_API_KEY); res.json({ temp: null, description: 'Error: ' + e.message, humidity: null, wind: null }); }
  });

  // Weather forecast with 7-day, spraying conditions, AI tips
  // Weather forecast cache
  const _weatherCache = {};
  app.get('/api/v1/farmer/weather/forecast', farmerAuth, async (req, res) => {
    try {
      const farmerId = req.farmer.id;
      // Return cache if fresh (30 min)
      if (_weatherCache[farmerId] && (Date.now() - _weatherCache[farmerId].ts < 30 * 60 * 1000)) {
        return res.json(_weatherCache[farmerId].data);
      }

      const farmerData = await pool.query('SELECT village, location, crops FROM farmers WHERE id = $1', [farmerId]);
      const farmer = farmerData.rows[0] || {};
      const city = farmer.village || (farmer.location && farmer.location.district) || 'Basti';
      const crops = farmer.crops || [];

      const axios = require('axios');
      // Hardcoded coords for common UP/Bihar cities to avoid geocoding API calls
      const cityCoords = { 'basti': [26.79, 82.73], 'gorakhpur': [26.75, 83.37], 'lucknow': [26.85, 80.95], 'varanasi': [25.32, 83.01], 'allahabad': [25.43, 81.85], 'patna': [25.6, 85.1], 'delhi': [28.61, 77.23], 'kanpur': [26.45, 80.35] };
      const cityLower = city.toLowerCase();
      let lat = 26.79, lon = 82.73;
      if (cityCoords[cityLower]) { lat = cityCoords[cityLower][0]; lon = cityCoords[cityLower][1]; }

      const forecastUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,windspeed_10m_max,weathercode,sunrise,sunset&hourly=temperature_2m,relativehumidity_2m,windspeed_10m,precipitation_probability&current=temperature_2m,relativehumidity_2m,windspeed_10m,weathercode&timezone=Asia/Kolkata&forecast_days=7';
      
      let fd;
      try {
        const forecastRes = await axios.get(forecastUrl, { timeout: 10000 });
        fd = forecastRes.data;
      } catch (fetchErr) {
        // If rate limited or network error, return fallback
        if (_weatherCache[farmerId]) return res.json(_weatherCache[farmerId].data);
        return res.json({ location: city, lat, lon, current: { temp: null, humidity: null, wind: null, weathercode: 0 }, daily: [], spray_windows: [], ai: { summary: 'Weather data temporarily unavailable. Try again in a few minutes.', tips: ['Check local weather before spraying', 'Avoid spraying in strong wind', 'Water crops in early morning', 'Monitor humidity levels'], monsoon_status: 'Data loading...', spray_advice: 'Try again shortly' } });
      }

      const current = { temp: Math.round(fd.current.temperature_2m), humidity: fd.current.relativehumidity_2m, wind: Math.round(fd.current.windspeed_10m), weathercode: fd.current.weathercode };

      const daily = fd.daily.time.map((date, i) => ({ date, temp_max: Math.round(fd.daily.temperature_2m_max[i]), temp_min: Math.round(fd.daily.temperature_2m_min[i]), precipitation: fd.daily.precipitation_sum[i], rain_chance: fd.daily.precipitation_probability_max[i], wind_max: Math.round(fd.daily.windspeed_10m_max[i]), weathercode: fd.daily.weathercode[i], sunrise: fd.daily.sunrise[i], sunset: fd.daily.sunset[i] }));

      const sprayWindows = [];
      const now = new Date();
      for (let h = 0; h < Math.min(72, fd.hourly.time.length); h++) {
        const t = new Date(fd.hourly.time[h]);
        if (t < now) continue;
        const wind = fd.hourly.windspeed_10m[h];
        const humidity = fd.hourly.relativehumidity_2m[h];
        const rainProb = fd.hourly.precipitation_probability[h];
        const hour = t.getHours();
        if (wind < 15 && humidity >= 40 && humidity <= 90 && rainProb < 30 && ((hour >= 6 && hour <= 10) || (hour >= 16 && hour <= 18))) {
          sprayWindows.push({ time: fd.hourly.time[h], wind, humidity, rain_chance: rainProb, quality: wind < 8 ? 'excellent' : 'good' });
        }
      }

      let aiTips = null;
      try {
        const Groq = require('groq-sdk');
        const groqAI = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const weatherSummary = 'Current: ' + current.temp + 'C, humidity ' + current.humidity + '%, wind ' + current.wind + 'km/h. Next 3 days: max temps ' + daily.slice(0,3).map(d=>d.temp_max).join(',') + 'C, rain chances ' + daily.slice(0,3).map(d=>d.rain_chance).join(',') + '%.';
        const tipPrompt = 'You are an Indian farming weather advisor. Based on this weather for ' + city + ': ' + weatherSummary + ' Farmer grows: ' + crops.join(', ') + '. Give a JSON object with: summary (2 line weather summary in Hindi-English mix), tips (array of 4 short actionable farming tips), monsoon_status (1 line about current monsoon phase), spray_advice (1 line about best spraying time). Keep it practical for UP/Bihar farmers.';
        const completion = await groqAI.chat.completions.create({ messages: [{ role: 'user', content: tipPrompt }], model: 'llama-3.3-70b-versatile', max_tokens: 800 });
        let reply = completion.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        aiTips = JSON.parse(reply);
      } catch(e) { aiTips = { summary: city + ' mein aaj ' + current.temp + ' degree hai. Humidity ' + current.humidity + '% hai.', tips: ['Subah 6-10 baje spray karna best hai', 'Barish ke baad 2 din ruk kar spray karein', 'Zyada hawa mein spray na karein', 'Pani dene ka samay subah ya shaam rakhein'], monsoon_status: 'Monsoon season active', spray_advice: 'Aaj spray ke liye ' + (current.wind < 15 ? 'sahi' : 'galat') + ' samay hai' }; }

      const responseData = { location: city, lat, lon, current, daily, spray_windows: sprayWindows.slice(0, 10), ai: aiTips };
      _weatherCache[farmerId] = { ts: Date.now(), data: responseData };
      res.json(responseData);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  // ====== REELS ======
  app.get('/api/v1/farmer/reels', communityAuth, async (req, res) => {
    try {
      // Try to get reels from database
      let reels = [];
      try {
        const { rows } = await pool.query('SELECT * FROM reels WHERE active = true ORDER BY created_at DESC LIMIT 20');
        reels = rows;
      } catch(e) {
        // Table might not exist, create it and return defaults
        await pool.query(`CREATE TABLE IF NOT EXISTS reels (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT, video_url TEXT NOT NULL, thumbnail TEXT, username TEXT, caption TEXT, crop TEXT, likes INT DEFAULT 0, comments INT DEFAULT 0, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(()=>{});
      }

      if (reels.length === 0) {
        // Return curated farming reels
        reels = [
          { id: '1', video_url: 'https://www.w3schools.com/html/mov_bbb.mp4', thumbnail: 'https://images.unsplash.com/photo-1625246333195-78d9c38ad449?w=400', username: 'KisanHelper', caption: 'Ganna ki fasal mein urea ka sahi tarika - 50kg per acre', likes: 234, comments: 18, crop: 'Ganna' },
          { id: '2', video_url: 'https://www.w3schools.com/html/movie.mp4', thumbnail: 'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=400', username: 'AgriExpert', caption: 'Gehu ki buwai November mein kaise karein - step by step', likes: 456, comments: 32, crop: 'Gehu' },
          { id: '3', video_url: 'https://www.w3schools.com/html/mov_bbb.mp4', thumbnail: 'https://images.unsplash.com/photo-1592982537447-6f2a6a0c7c18?w=400', username: 'OrganicFarm', caption: 'Vermicompost banane ka aasan tarika - 30 din mein taiyaar', likes: 789, comments: 56, crop: 'Organic' },
          { id: '4', video_url: 'https://www.w3schools.com/html/movie.mp4', thumbnail: 'https://images.unsplash.com/photo-1464226184884-fa280b87c399?w=400', username: 'SoilDoctor', caption: 'Mitti ki jaanch ghar pe - pH test simple trick', likes: 321, comments: 24, crop: 'General' },
          { id: '5', video_url: 'https://www.w3schools.com/html/mov_bbb.mp4', thumbnail: 'https://images.unsplash.com/photo-1530836369250-ef72a3f5cda8?w=400', username: 'CropGuard', caption: 'Neem ka tel - best organic pest control spray', likes: 567, comments: 41, crop: 'Sabji' },
          { id: '6', video_url: 'https://www.w3schools.com/html/movie.mp4', thumbnail: 'https://images.unsplash.com/photo-1595855759920-86582396756a?w=400', username: 'MandiGuru', caption: 'Mandi mein best rate kaise milega - 5 tips', likes: 892, comments: 67, crop: 'General' },
          { id: '7', video_url: 'https://www.w3schools.com/html/mov_bbb.mp4', thumbnail: 'https://images.unsplash.com/photo-1500937386664-56d1dfef3854?w=400', username: 'IrrigationPro', caption: 'Drip irrigation lagane ka kharcha aur fayda', likes: 445, comments: 29, crop: 'Ganna' },
          { id: '8', video_url: 'https://www.w3schools.com/html/movie.mp4', thumbnail: 'https://images.unsplash.com/photo-1523348837708-15d4a09cfac2?w=400', username: 'GovSchemes', caption: 'PM Kisan Yojana - online apply kaise karein 2025', likes: 1234, comments: 89, crop: 'General' },
        ];
      }
      res.json({ reels });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST - Admin add reel
  // ====== GOVERNMENT SCHEMES ======
  app.get('/api/v1/farmer/schemes', farmerAuth, async (req, res) => {
    try {
      const Groq = require('groq-sdk');
      const groqAI = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const farmerId = req.farmer.id;
      const farmerData = await pool.query('SELECT crops, village, land_holding_acres FROM farmers WHERE id = $1', [farmerId]);
      const farmer = farmerData.rows[0] || {};

      const prompt = `List 5 current Indian government schemes available for a farmer growing ${(farmer.crops || ['crops']).join(', ')} with ${farmer.land_holding_acres || 'small'} acres land in ${farmer.village || 'Uttar Pradesh'}. Return JSON array with fields: name, description (1 line), benefit (monetary or other), eligibility (short), how_to_apply (1 line). Include PM-KISAN, PM Fasal Bima if relevant.`;

      const completion = await groqAI.chat.completions.create({ messages: [{ role: 'user', content: prompt }], model: 'llama-3.3-70b-versatile', max_tokens: 1500 });
      let reply = completion.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      try {
        const parsed = JSON.parse(reply);
        res.json({ schemes: Array.isArray(parsed) ? parsed : parsed.schemes || [] });
      } catch (parseErr) {
        res.json({ schemes: [] });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  // ====== SOIL HEALTH ======
  app.get('/api/v1/farmer/soil-health', farmerAuth, async (req, res) => {
    try {
      const farmerId = req.farmer.id;
      const farmerData = await pool.query('SELECT village, location, pin_code, crops FROM farmers WHERE id = $1', [farmerId]);
      const farmer = farmerData.rows[0] || {};
      const district = (farmer.location && farmer.location.district) || farmer.village || '';

      const soilData = await pool.query(
        'SELECT * FROM soil_nutrient_data WHERE UPPER(district_name) = UPPER($1) ORDER BY sample_year DESC LIMIT 10',
        [district]
      );

      if (soilData.rows.length === 0) {
        return res.json({ message: 'No soil data available for your district', district });
      }

      const row = soilData.rows[0];
      const macronutrients = [
        { name: 'Nitrogen (N)', low: row.nitrogen_low_pct, medium: row.nitrogen_medium_pct, high: row.nitrogen_high_pct, status: parseFloat(row.nitrogen_high_pct) > 30 ? 'good' : parseFloat(row.nitrogen_medium_pct) > 50 ? 'medium' : 'low' },
        { name: 'Phosphorus (P)', low: row.phosphorus_low_pct, medium: row.phosphorus_medium_pct, high: row.phosphorus_high_pct, status: parseFloat(row.phosphorus_high_pct) > 30 ? 'good' : parseFloat(row.phosphorus_medium_pct) > 50 ? 'medium' : 'low' },
        { name: 'Potassium (K)', low: row.potassium_low_pct, medium: row.potassium_medium_pct, high: row.potassium_high_pct, status: parseFloat(row.potassium_high_pct) > 30 ? 'good' : parseFloat(row.potassium_medium_pct) > 50 ? 'medium' : 'low' },
        { name: 'Organic Carbon', low: row.organic_carbon_low_pct, medium: row.organic_carbon_medium_pct, high: row.organic_carbon_high_pct, status: parseFloat(row.organic_carbon_high_pct) > 30 ? 'good' : parseFloat(row.organic_carbon_medium_pct) > 50 ? 'medium' : 'low' },
      ];

      const micronutrients = [
        { name: 'Zinc (Zn)', sufficient: row.zinc_sufficient_pct, deficient: row.zinc_deficient_pct, status: parseFloat(row.zinc_sufficient_pct) > 50 ? 'good' : parseFloat(row.zinc_sufficient_pct) > 25 ? 'medium' : 'low' },
        { name: 'Iron (Fe)', sufficient: row.iron_sufficient_pct, deficient: row.iron_deficient_pct, status: parseFloat(row.iron_sufficient_pct) > 50 ? 'good' : 'low' },
        { name: 'Copper (Cu)', sufficient: row.copper_sufficient_pct, deficient: row.copper_deficient_pct, status: parseFloat(row.copper_sufficient_pct) > 50 ? 'good' : 'low' },
        { name: 'Manganese (Mn)', sufficient: row.manganese_sufficient_pct, deficient: row.manganese_deficient_pct, status: parseFloat(row.manganese_sufficient_pct) > 50 ? 'good' : 'low' },
        { name: 'Boron (B)', sufficient: row.boron_sufficient_pct, deficient: row.boron_deficient_pct, status: parseFloat(row.boron_sufficient_pct) > 50 ? 'good' : parseFloat(row.boron_sufficient_pct) > 25 ? 'medium' : 'low' },
        { name: 'Sulphur (S)', sufficient: row.sulphur_sufficient_pct, deficient: row.sulphur_deficient_pct, status: parseFloat(row.sulphur_sufficient_pct) > 50 ? 'good' : parseFloat(row.sulphur_sufficient_pct) > 25 ? 'medium' : 'low' },
      ];

      const phData = { value: row.avg_ph, acidic: row.ph_acidic_pct, neutral: row.ph_neutral_pct, alkaline: row.ph_alkaline_pct, status: (parseFloat(row.avg_ph) >= 6.5 && parseFloat(row.avg_ph) <= 7.5) ? 'good' : 'medium' };
      const ecData = { saline: row.ec_saline_pct, nonSaline: row.ec_non_saline_pct };

      // Get stored recommendations
      let recommendations = row.recommendations || {};
      if (typeof recommendations === 'string') { try { recommendations = JSON.parse(recommendations); } catch(e) {} }

      // Generate crop-specific recommendations if farmer has crops
      let cropRecommendations = [];
      const farmerCrops = farmer.crops || [];
      if (farmerCrops.length > 0 && process.env.GROQ_API_KEY) {
        try {
          const Groq = require('groq-sdk');
          const groqAI = new Groq({ apiKey: process.env.GROQ_API_KEY });
          const soilSummary = 'Nitrogen: ' + row.nitrogen_low_pct + '% low, Phosphorus: ' + row.phosphorus_medium_pct + '% medium, Potassium: ' + row.potassium_medium_pct + '% medium, OC: ' + row.organic_carbon_low_pct + '% low, Zinc: ' + row.zinc_deficient_pct + '% deficient, pH: ' + row.avg_ph + ', Soil: ' + (row.soil_type || 'Neutral');
          const completion = await groqAI.chat.completions.create({
            messages: [{ role: 'user', content: 'Given this soil data for ' + district + ' district: ' + soilSummary + '. The farmer grows: ' + farmerCrops.join(', ') + '. Give 5 specific fertilizer/soil management recommendations for these crops based on this soil data. Return JSON array of objects with fields: crop, recommendation, fertilizer, dosage. Keep recommendations practical and in simple language.' }],
            model: 'llama-3.3-70b-versatile',
            max_tokens: 800,
          });
          let reply = completion.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          try { cropRecommendations = JSON.parse(reply); } catch(e) {}
        } catch(e) { console.log('Crop recs AI error:', e.message); }
      }

      res.json({
        district: row.district_name,
        block: row.block_name,
        sample_year: row.sample_year,
        cycle: row.cycle,
        total_samples: row.total_samples,
        soil_type: row.soil_type,
        source: row.source,
        macronutrients,
        micronutrients,
        ph: phData,
        ec: ecData,
        recommendations,
        crop_recommendations: cropRecommendations,
        all_blocks: soilData.rows.map(r => ({ block: r.block_name, samples: r.total_samples, year: r.sample_year })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ====== CROP RECOMMENDATIONS ======
  app.get('/api/v1/farmer/crop-recommendations', farmerAuth, async (req, res) => {
    try {
      const farmerId = req.farmer.id;
      const farmerData = await pool.query('SELECT crops, village, location, soil_type, land_holding_acres FROM farmers WHERE id = $1', [farmerId]);
      const farmer = farmerData.rows[0] || {};
      const district = farmer.location ? farmer.location.district : farmer.village;

      const Groq = require('groq-sdk');
      const groqAI = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const prompt = `Based on the soil and climate of ${district || 'UP'} district, India, recommend 5 crops that a farmer with ${farmer.land_holding_acres || 'small'} acres should grow. Current crops: ${(farmer.crops || []).join(', ')}. Return JSON array with fields: crop, reason (1 line why this crop suits this area). Focus on profitable and suitable crops for this region.`;
      
      const completion = await groqAI.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        max_tokens: 600,
      });
      let reply = completion.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      try {
        const parsed = JSON.parse(reply);
        res.json({ recommendations: Array.isArray(parsed) ? parsed : parsed.recommendations || [] });
      } catch (e) {
        res.json({ recommendations: [] });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  // ====== COMMUNITY ======
  
// Middleware that accepts both admin and farmer tokens


app.get('/api/v1/farmer/community/posts', communityAuth, async (req, res) => {
    try {
      const { search, filter } = req.query;
      let q = 'SELECT p.*, p.username, (SELECT COUNT(*) FROM community_likes WHERE post_id = p.id) as likes, (SELECT COUNT(*) FROM community_comments WHERE post_id = p.id) as comments_count, EXISTS(SELECT 1 FROM community_likes WHERE post_id = p.id AND farmer_id = $' + '1) as liked_by_me FROM community_posts p WHERE 1=1';
      const vals = [req.farmer.id]; let idx = 2;
      if (search) { q += ' AND (p.content ILIKE $' + idx + ' OR p.crop ILIKE $' + idx + ' OR p.username ILIKE $' + idx + ')'; vals.push('%' + search + '%'); idx++; }
      if (filter === 'photos') q += ' AND p.image_url IS NOT NULL';
      if (filter === 'videos') { q += ' AND p.image_url LIKE $' + idx; vals.push('%.mp4%'); idx++; }
      if (filter === 'questions') { q += ' AND p.content LIKE $' + idx; vals.push('%?%'); idx++; }
      q += ' ORDER BY p.created_at DESC LIMIT 50';
      const { rows } = await pool.query(q, vals);
      const posts = rows.map(p => ({ ...p, media_url: p.image_url, media_type: p.image_url ? (p.image_url.match(/\.(mp4|mov|avi|webm)/i) ? 'video' : 'image') : null, tags: p.crop ? [p.crop] : [] }));
      res.json({ posts });
    } catch (e) {
      if (e.message && e.message.includes('does not exist')) {
        try {
          await pool.query('CREATE TABLE IF NOT EXISTS community_posts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id UUID, username TEXT, content TEXT, image_url TEXT, category TEXT, crop TEXT, created_at TIMESTAMPTZ DEFAULT NOW())');
          await pool.query('CREATE TABLE IF NOT EXISTS community_likes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID, farmer_id UUID, created_at TIMESTAMPTZ DEFAULT NOW())');
          await pool.query('CREATE TABLE IF NOT EXISTS community_comments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID, farmer_id UUID, username TEXT, text TEXT, created_at TIMESTAMPTZ DEFAULT NOW())');
          res.json({ posts: [] });
        } catch (e2) { res.json({ posts: [] }); }
      } else { res.status(500).json({ error: e.message }); }
    }
  });

  app.post('/api/v1/farmer/community/posts', communityAuth, upload.single('media'), async (req, res) => {
    try {
      const { content, category, crop, image_url, username } = req.body;
      if (!content) return res.status(400).json({ error: 'Content required' });
      // Update username if provided
      if (username) { await pool.query('UPDATE farmers SET community_username = $1 WHERE id = $2', [username, req.farmer.id]).catch(() => {}); }
      let farmerId = req.farmer.id;
      if (req.isAdmin) {
        const fCheck = await pool.query('SELECT id FROM farmers WHERE id = $1', [farmerId]).catch(() => ({ rows: [] }));
        if (!fCheck.rows.length) {
          await pool.query('ALTER TABLE community_posts ALTER COLUMN farmer_id DROP NOT NULL').catch(() => {});
          await pool.query('ALTER TABLE community_posts DROP CONSTRAINT IF EXISTS community_posts_farmer_id_fkey').catch(() => {});
        }
      }
      const { rows } = await pool.query(
        `INSERT INTO community_posts (farmer_id, username, content, image_url, category, crop, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
        [farmerId, username || (req.isAdmin ? 'VartMap Official' : 'Farmer'), content, req.file ? (await uploadToCloudinary(req.file.buffer, { folder: 'vartmap/community' })).secure_url : image_url || null, category || 'general', crop || null]
      );


      res.json({ post: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v1/farmer/community/posts/:id/like', communityAuth, async (req, res) => {
    try {
      const existing = await pool.query('SELECT * FROM community_likes WHERE post_id = $1 AND farmer_id = $2', [req.params.id, req.farmer.id]);
      if (existing.rows.length > 0) {
        await pool.query('DELETE FROM community_likes WHERE post_id = $1 AND farmer_id = $2', [req.params.id, req.farmer.id]);
        res.json({ liked: false });
      } else {
        await pool.query('INSERT INTO community_likes (post_id, farmer_id) VALUES ($1, $2)', [req.params.id, req.farmer.id]);
        res.json({ liked: true });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET single post
  app.get('/api/v1/farmer/community/posts/:id', communityAuth, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT p.*, p.username, (SELECT COUNT(*) FROM community_likes WHERE post_id = p.id) as likes, (SELECT COUNT(*) FROM community_comments WHERE post_id = p.id) as comments_count, EXISTS(SELECT 1 FROM community_likes WHERE post_id = p.id AND farmer_id = $1) as liked_by_me FROM community_posts p WHERE p.id = $2', [req.farmer.id, req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Post not found' });
      const post = { ...rows[0], media_url: rows[0].image_url, media_type: rows[0].image_url ? (rows[0].image_url.match(/\.(mp4|mov|avi|webm)/i) ? 'video' : 'image') : null, tags: rows[0].crop ? [rows[0].crop] : [] };
      res.json({ post });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET comments
  app.get('/api/v1/farmer/community/posts/:id/comments', communityAuth, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM community_comments WHERE post_id = $1 ORDER BY created_at ASC', [req.params.id]);
      res.json({ comments: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST comment
  app.post('/api/v1/farmer/community/posts/:id/comments', communityAuth, async (req, res) => {
    try {
      const { text, username } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });
      const uname = username || 'Farmer';
      const { rows } = await pool.query('INSERT INTO community_comments (post_id, farmer_id, username, text, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *', [req.params.id, req.farmer.id, uname, text]);
      res.json({ comment: rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/v1/farmer/community/posts/:id/comments', farmerAuth, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM community_comments WHERE post_id = $1 ORDER BY created_at ASC', [req.params.id]);
      res.json({ comments: rows });
    } catch (e) { res.json({ comments: [] }); }
  });

  // ====== FARMER PRODUCT CATALOG (from brand_products + crop_recommendations) ======
  app.get('/api/v1/farmer/catalog', farmerAuth, async (req, res) => {
    try {
      const farmerId = req.farmer.id;
      const farmerData = await pool.query('SELECT crops, location FROM farmers WHERE id = $1', [farmerId]);
      const farmer = farmerData.rows[0] || {};
      const crops = farmer.crops || [];

      // Get all active products
      const products = await pool.query('SELECT * FROM brand_products WHERE is_active = true ORDER BY sort_order, product_name');

      // Get crop recommendations for farmer's crops
      let recommendations = [];
      if (crops.length > 0) {
        const cropList = crops.map(c => c.toLowerCase());
        recommendations = (await pool.query(`SELECT cr.*, bp.product_name, bp.product_code, bp.image_url, bp.composition, bp.dosage_per_acre, bp.benefits, bp.benefits_hi FROM crop_recommendations cr JOIN brand_products bp ON cr.product_id = bp.id WHERE cr.is_active = true AND LOWER(cr.crop_name) = ANY($1) ORDER BY cr.priority DESC`, [cropList])).rows;
      }

      res.json({ products: products.rows, recommendations, farmer_crops: crops });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


// ===== YOUTUBE SHORTS AUTO-SYNC =====
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';

async function syncYouTubeShorts() {
  if (!YOUTUBE_API_KEY || !YOUTUBE_CHANNEL_ID) {
    console.log('[YouTube Sync] Missing API key or Channel ID, skipping');
    return;
  }
  try {
    // Create reels table if not exists
    await pool.query(`CREATE TABLE IF NOT EXISTS reels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT,
      video_url TEXT NOT NULL,
      thumbnail TEXT,
      username TEXT DEFAULT 'VartMap Official',
      caption TEXT,
      crop TEXT DEFAULT '',
      likes INT DEFAULT 0,
      comments INT DEFAULT 0,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // UUSH prefix = Shorts playlist
    const playlistId = YOUTUBE_CHANNEL_ID.replace('UC', 'UUSH');
    const ytRes = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
      params: {
        part: 'snippet,contentDetails',
        playlistId: playlistId,
        maxResults: 20,
        key: YOUTUBE_API_KEY
      }
    });

    let added = 0;
    for (const item of (ytRes.data.items || [])) {
      const videoId = item.contentDetails.videoId;
      const snippet = item.snippet;
      const existing = await pool.query('SELECT id FROM reels WHERE video_url LIKE $1', ['%' + videoId + '%']);
      if (existing.rows.length === 0) {
        await pool.query(
          'INSERT INTO reels (title, video_url, thumbnail, username, caption, crop, active) VALUES ($1, $2, $3, $4, $5, $6, true)',
          [
            snippet.title || 'VartMap Short',
            'https://www.youtube.com/shorts/' + videoId,
            (snippet.thumbnails && snippet.thumbnails.high && snippet.thumbnails.high.url) || (snippet.thumbnails && snippet.thumbnails.default && snippet.thumbnails.default.url) || '',
            'VartMap Official',
            (snippet.description || snippet.title || '').substring(0, 200),
            ''
          ]
        );
        added++;
      }
    }
    console.log('[YouTube Sync] Done. Added ' + added + ' new shorts.');
  } catch (e) {
    console.error('[YouTube Sync] Error:', e.message);
  }
}

// Sync on startup and every 30 minutes
if (YOUTUBE_API_KEY && YOUTUBE_CHANNEL_ID) {
  setTimeout(syncYouTubeShorts, 10000); // 10s after startup
  setInterval(syncYouTubeShorts, 30 * 60 * 1000);
}

// Manual sync endpoint (admin)
app.post('/api/v1/admin/sync-youtube', auth, async (req, res) => {
  try {
    await syncYouTubeShorts();
    res.json({ success: true, message: 'YouTube Shorts sync completed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET reels endpoint for farmer app


// DELETE community post (admin)
app.delete('/api/v1/farmer/community/posts/:id', communityAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM community_comments WHERE post_id = $1', [req.params.id]);
    await pool.query('DELETE FROM community_likes WHERE post_id = $1', [req.params.id]);
    await pool.query('DELETE FROM community_posts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE reel (admin)
app.delete('/api/v1/farmer/reels/:id', communityAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM reels WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST reel (admin)
app.post('/api/v1/farmer/reels', communityAuth, upload.single('video'), async (req, res) => {
  try {
    const { video_url, caption, thumbnail, crop } = req.body;
    let fileUrl = null;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { resource_type: 'video', folder: 'vartmap/reels' });
      fileUrl = result.secure_url;
    }
    const finalUrl = fileUrl || video_url;
    if (!finalUrl) return res.status(400).json({ error: 'video_url or file required' });
    await pool.query(`CREATE TABLE IF NOT EXISTS reels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT, video_url TEXT NOT NULL, thumbnail TEXT,
      username TEXT DEFAULT 'VartMap Official', caption TEXT,
      crop TEXT DEFAULT '', likes INT DEFAULT 0, comments INT DEFAULT 0,
      active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const { rows } = await pool.query(
      'INSERT INTO reels (title, video_url, thumbnail, username, caption, crop, active) VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *',
      [caption || '', finalUrl, thumbnail || '', 'VartMap Official', caption || '', crop || '']
    );
    res.json({ reel: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== END YOUTUBE SHORTS SYNC =====

// ===== VIDEO MANAGEMENT =====
app.get('/api/v1/videos', auth, async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS videos (
      id SERIAL PRIMARY KEY, video_id VARCHAR(20) NOT NULL, title VARCHAR(255) NOT NULL,
      duration VARCHAR(10) DEFAULT '0:00', type VARCHAR(10) DEFAULT 'short' CHECK (type IN ('short','video')),
      category VARCHAR(100), is_active BOOLEAN DEFAULT true, order_num INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const { rows } = await pool.query('SELECT * FROM videos ORDER BY order_num ASC, created_at DESC');
    res.json({ videos: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/videos/public', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS videos (
      id SERIAL PRIMARY KEY, video_id VARCHAR(20) NOT NULL, title VARCHAR(255) NOT NULL,
      duration VARCHAR(10) DEFAULT '0:00', type VARCHAR(10) DEFAULT 'short' CHECK (type IN ('short','video')),
      category VARCHAR(100), is_active BOOLEAN DEFAULT true, order_num INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const { rows } = await pool.query('SELECT * FROM videos WHERE is_active = true ORDER BY order_num ASC, created_at DESC');
    res.json({ videos: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/videos', auth, async (req, res) => {
  try {
    const { video_id, title, duration, type, category, order_num } = req.body;
    if (!video_id || !title) return res.status(400).json({ error: 'video_id and title required' });
    const { rows } = await pool.query(
      'INSERT INTO videos (video_id, title, duration, type, category, order_num) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [video_id, title, duration || '0:00', type || 'short', category || null, order_num || 0]
    );
    res.json({ video: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v1/videos/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { video_id, title, duration, type, category, is_active, order_num } = req.body;
    const { rows } = await pool.query(
      `UPDATE videos SET video_id=COALESCE($1,video_id), title=COALESCE($2,title),
       duration=COALESCE($3,duration), type=COALESCE($4,type), category=COALESCE($5,category),
       is_active=COALESCE($6,is_active), order_num=COALESCE($7,order_num), updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [video_id, title, duration, type, category, is_active, order_num, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Video not found' });
    res.json({ video: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/v1/videos/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM videos WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Video not found' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/videos/:id/toggle', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE videos SET is_active = NOT is_active, updated_at=NOW() WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Video not found' });
    res.json({ video: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ===== END VIDEO MANAGEMENT =====

// ===== FARM FINANCE MANAGEMENT =====
app.get('/api/v1/farmer/finance/summary', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    let decoded;
    try { decoded = jwt.verify(token, 'vartmap-farmer-secret-2024'); } catch { try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); } }
    const farmerId = decoded.farmerId || decoded.id;

    await pool.query(`CREATE TABLE IF NOT EXISTS farm_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      farmer_id UUID NOT NULL,
      type VARCHAR(10) NOT NULL CHECK (type IN ('income','expense')),
      amount NUMERIC(12,2) NOT NULL,
      category VARCHAR(50) NOT NULL,
      crop VARCHAR(50),
      description TEXT,
      date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    const { rows: totals } = await pool.query(
      "SELECT type, COALESCE(SUM(amount),0) as total FROM farm_transactions WHERE farmer_id=$1 AND date >= DATE_TRUNC('month', CURRENT_DATE) GROUP BY type",
      [farmerId]
    );
    const income = parseFloat((totals.find(t => t.type === 'income') || {}).total || 0);
    const expense = parseFloat((totals.find(t => t.type === 'expense') || {}).total || 0);

    const { rows: byCategory } = await pool.query(
      "SELECT category, COALESCE(SUM(amount),0) as total FROM farm_transactions WHERE farmer_id=$1 AND type='expense' AND date >= DATE_TRUNC('month', CURRENT_DATE) GROUP BY category ORDER BY total DESC",
      [farmerId]
    );

    const { rows: byCrop } = await pool.query(
      "SELECT crop, type, COALESCE(SUM(amount),0) as total FROM farm_transactions WHERE farmer_id=$1 AND crop IS NOT NULL AND date >= DATE_TRUNC('year', CURRENT_DATE) GROUP BY crop, type ORDER BY crop",
      [farmerId]
    );

    const { rows: recent } = await pool.query(
      "SELECT * FROM farm_transactions WHERE farmer_id=$1 ORDER BY date DESC, created_at DESC LIMIT 20",
      [farmerId]
    );

    res.json({ income, expense, profit: income - expense, byCategory, byCrop, recent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/farmer/finance/transactions', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    let decoded;
    try { decoded = jwt.verify(token, 'vartmap-farmer-secret-2024'); } catch { try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); } }
    const farmerId = decoded.farmerId || decoded.id;
    const { type, crop, month } = req.query;

    let q = 'SELECT * FROM farm_transactions WHERE farmer_id=$1';
    const params = [farmerId];
    let idx = 2;
    if (type) { q += ' AND type=$' + idx; params.push(type); idx++; }
    if (crop) { q += ' AND crop=$' + idx; params.push(crop); idx++; }
    if (month) { q += " AND TO_CHAR(date, 'YYYY-MM') = $" + idx; params.push(month); idx++; }
    q += ' ORDER BY date DESC, created_at DESC LIMIT 100';

    const { rows } = await pool.query(q, params);
    res.json({ transactions: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/farmer/finance/transaction', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    let decoded;
    try { decoded = jwt.verify(token, 'vartmap-farmer-secret-2024'); } catch { try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); } }
    const farmerId = decoded.farmerId || decoded.id;

    const { type, amount, category, crop, description, date } = req.body;
    if (!type || !amount || !category) return res.status(400).json({ error: 'type, amount, category required' });

    await pool.query(`CREATE TABLE IF NOT EXISTS farm_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      farmer_id UUID NOT NULL,
      type VARCHAR(10) NOT NULL CHECK (type IN ('income','expense')),
      amount NUMERIC(12,2) NOT NULL,
      category VARCHAR(50) NOT NULL,
      crop VARCHAR(50),
      description TEXT,
      date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    const { rows } = await pool.query(
      'INSERT INTO farm_transactions (farmer_id, type, amount, category, crop, description, date) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [farmerId, type, amount, category, crop || null, description || null, date || new Date().toISOString().split('T')[0]]
    );
    res.json({ transaction: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/v1/farmer/finance/transaction/:id', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    let decoded;
    try { decoded = jwt.verify(token, 'vartmap-farmer-secret-2024'); } catch { try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); } }
    const farmerId = decoded.farmerId || decoded.id;

    const { rows } = await pool.query('DELETE FROM farm_transactions WHERE id=$1 AND farmer_id=$2 RETURNING *', [req.params.id, farmerId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ===== END FARM FINANCE =====

// ===== ADMIN FINANCE OVERVIEW =====
app.get('/api/v1/finance/overview', auth, async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS farm_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id UUID NOT NULL,
      type VARCHAR(10) NOT NULL, amount NUMERIC(12,2) NOT NULL,
      category VARCHAR(50) NOT NULL, crop VARCHAR(50), description TEXT,
      date DATE DEFAULT CURRENT_DATE, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    const { rows: totals } = await pool.query(
      "SELECT type, COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM farm_transactions WHERE date >= DATE_TRUNC('month', CURRENT_DATE) GROUP BY type"
    );
    const income = parseFloat((totals.find(t => t.type === 'income') || {}).total || 0);
    const expense = parseFloat((totals.find(t => t.type === 'expense') || {}).total || 0);
    const incomeCount = parseInt((totals.find(t => t.type === 'income') || {}).count || 0);
    const expenseCount = parseInt((totals.find(t => t.type === 'expense') || {}).count || 0);

    const { rows: topFarmers } = await pool.query(`
      SELECT f.name, f.phone, ft.type,
        COALESCE(SUM(ft.amount),0) as total, COUNT(*) as entries
      FROM farm_transactions ft
      JOIN farmers f ON f.id = ft.farmer_id
      WHERE ft.date >= DATE_TRUNC('month', CURRENT_DATE)
      GROUP BY f.name, f.phone, ft.type
      ORDER BY total DESC LIMIT 20
    `);

    const { rows: byCategory } = await pool.query(
      "SELECT category, type, COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM farm_transactions WHERE date >= DATE_TRUNC('month', CURRENT_DATE) GROUP BY category, type ORDER BY total DESC"
    );

    const { rows: recent } = await pool.query(`
      SELECT ft.*, f.name as farmer_name, f.phone as farmer_phone
      FROM farm_transactions ft
      JOIN farmers f ON f.id = ft.farmer_id
      ORDER BY ft.created_at DESC LIMIT 50
    `);

    const { rows: monthly } = await pool.query(`
      SELECT TO_CHAR(date, 'YYYY-MM') as month, type, COALESCE(SUM(amount),0) as total
      FROM farm_transactions
      WHERE date >= NOW() - INTERVAL '6 months'
      GROUP BY TO_CHAR(date, 'YYYY-MM'), type
      ORDER BY month
    `);

    const { rows: activeFarmers } = await pool.query(
      "SELECT COUNT(DISTINCT farmer_id) as count FROM farm_transactions WHERE date >= DATE_TRUNC('month', CURRENT_DATE)"
    );

    res.json({
      income, expense, profit: income - expense,
      incomeCount, expenseCount,
      activeFarmers: parseInt(activeFarmers[0]?.count || 0),
      topFarmers, byCategory, recent, monthly
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/finance/farmer/:farmerId', auth, async (req, res) => {
  try {
    const { farmerId } = req.params;
    const { rows: farmer } = await pool.query('SELECT name, phone, crops FROM farmers WHERE id=$1', [farmerId]);
    const { rows: totals } = await pool.query(
      "SELECT type, COALESCE(SUM(amount),0) as total FROM farm_transactions WHERE farmer_id=$1 AND date >= DATE_TRUNC('month', CURRENT_DATE) GROUP BY type",
      [farmerId]
    );
    const { rows: transactions } = await pool.query(
      'SELECT * FROM farm_transactions WHERE farmer_id=$1 ORDER BY date DESC LIMIT 50',
      [farmerId]
    );
    const income = parseFloat((totals.find(t => t.type === 'income') || {}).total || 0);
    const expense = parseFloat((totals.find(t => t.type === 'expense') || {}).total || 0);
    res.json({ farmer: farmer[0] || {}, income, expense, profit: income - expense, transactions });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ===== END ADMIN FINANCE =====









  


  
  // ===== COMPREHENSIVE FARMER PROFILE =====
  app.get("/api/v1/farmers/:id/full-profile", auth, async (req, res) => {
    try {
      const fid = req.params.id;
      const { rows: fr } = await pool.query("SELECT * FROM farmers WHERE id=$1", [fid]);
      if (!fr[0]) return res.status(404).json({ error: "Farmer not found" });
      const farmer = fr[0];
      const msgs = await pool.query("SELECT * FROM wa_messages WHERE farmer_id=$1 ORDER BY created_at DESC LIMIT 50", [fid]).then(r => r.rows).catch(() => []);
      const posts = await pool.query("SELECT * FROM community_posts WHERE farmer_id=$1 ORDER BY created_at DESC LIMIT 20", [fid]).then(r => r.rows).catch(() => []);
      const diagnoses = await pool.query("SELECT * FROM wa_messages WHERE farmer_id=$1 AND (content ILIKE $2 OR content ILIKE $3 OR content ILIKE $4 OR content ILIKE $5) ORDER BY created_at DESC LIMIT 20", [fid, "%diagnos%", "%disease%", "%pest%", "%treatment%"]).then(r => r.rows).catch(() => []);
      const txns = await pool.query("SELECT * FROM farm_transactions WHERE farmer_id=$1 ORDER BY date DESC LIMIT 50", [fid]).then(r => r.rows).catch(() => []);
      const finRes = await pool.query("SELECT COALESCE(SUM(CASE WHEN type=$2 THEN amount ELSE 0 END),0) as total_income, COALESCE(SUM(CASE WHEN type=$3 THEN amount ELSE 0 END),0) as total_expense, COUNT(*) as total_entries FROM farm_transactions WHERE farmer_id=$1", [fid, "income", "expense"]).catch(() => ({rows:[{total_income:0,total_expense:0,total_entries:0}]}));
      const monthlyFin = await pool.query("SELECT TO_CHAR(date,$2) as month, COALESCE(SUM(CASE WHEN type=$3 THEN amount ELSE 0 END),0) as income, COALESCE(SUM(CASE WHEN type=$4 THEN amount ELSE 0 END),0) as expense FROM farm_transactions WHERE farmer_id=$1 AND date >= NOW()-INTERVAL '6 months' GROUP BY TO_CHAR(date,$2) ORDER BY month", [fid, "YYYY-MM", "income", "expense"]).then(r => r.rows).catch(() => []);
      const expByCat = await pool.query("SELECT category, SUM(amount) as total FROM farm_transactions WHERE farmer_id=$1 AND type=$2 GROUP BY category ORDER BY total DESC LIMIT 10", [fid, "expense"]).then(r => r.rows).catch(() => []);
      const loyalty = await pool.query("SELECT * FROM farmer_loyalty WHERE farmer_id=$1", [fid]).then(r => r.rows[0] || null).catch(() => null);
      const spins = await pool.query("SELECT * FROM spin_results WHERE farmer_id=$1 ORDER BY created_at DESC LIMIT 10", [fid]).then(r => r.rows).catch(() => []);
      const iStats = await pool.query("SELECT COUNT(*) as total_messages, COUNT(CASE WHEN direction=$2 THEN 1 END) as inbound, COUNT(CASE WHEN direction=$3 THEN 1 END) as outbound FROM wa_messages WHERE farmer_id=$1", [fid, "inbound", "outbound"]).then(r => r.rows[0]).catch(() => ({total_messages:0,inbound:0,outbound:0}));
      const reels = await pool.query("SELECT * FROM reels WHERE farmer_id=$1 ORDER BY created_at DESC LIMIT 10", [fid]).then(r => r.rows).catch(() => []);
      res.json({farmer, messages:msgs, posts, diagnoses, transactions:txns, financeSummary:finRes.rows[0], monthlyFinance:monthlyFin, expenseByCategory:expByCat, loyalty, spins, interactionStats:iStats, reelActivity:reels});
    } catch(e) { console.error("Full profile error:", e); res.status(500).json({error:e.message}); }
  });

  // AI Summary - GROQ primary (Gemini location-blocked on Render)
  app.post("/api/v1/farmers/:id/ai-summary", auth, async (req, res) => {
    try {
      const { profileData } = req.body;
      const prompt = "You are an agricultural business analyst for VartMap, an Indian agri-tech platform. Analyze this farmer completely and provide a detailed summary in 4-5 paragraphs covering: 1) Farmer Overview & Engagement Level 2) Farming Activities & Crop Focus 3) Financial Health Assessment 4) Communication Patterns & Platform Usage 5) Actionable Recommendations. Be specific with numbers and dates. Keep under 350 words. Farmer Data: " + JSON.stringify(profileData);
      
      let summary = null;

      // Primary: GROQ (fast, reliable, no location restrictions)
      if (!summary && process.env.GROQ_API_KEY) {
        try {
          const Groq = require("groq-sdk");
          const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
          const completion = await groq.chat.completions.create({
            messages: [{ role: "system", content: "You are a professional agricultural business analyst." }, { role: "user", content: prompt }],
            model: "llama-3.3-70b-versatile",
            temperature: 0.6,
            max_tokens: 600
          });
          summary = completion.choices[0].message.content;
          console.log("AI Summary: Generated via GROQ");
        } catch(groqErr) {
          console.log("GROQ failed:", groqErr.message);
        }
      }

      // Fallback: Gemini 2.0 Flash (may work when quota resets)
      if (!summary && process.env.GEMINI_API_KEY) {
        try {
          const { GoogleGenerativeAI } = require("@google/generative-ai");
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
          const result = await model.generateContent(prompt);
          summary = result.response.text();
          console.log("AI Summary: Generated via Gemini fallback");
        } catch(gemErr) {
          console.log("Gemini fallback failed:", gemErr.message.substring(0, 100));
        }
      }

      res.json({ summary: summary || "AI summary temporarily unavailable. Please try again in a minute." });
    } catch(e) { res.json({ summary: "Error: " + e.message }); }
  });


  // ===== CROP CALENDAR & SMART REMINDERS =====
  
  // Create tables on first load
  (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS crop_calendar_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        crop VARCHAR(100) NOT NULL,
        stage_name VARCHAR(200) NOT NULL,
        day_offset INTEGER NOT NULL,
        message_hi TEXT NOT NULL,
        message_en TEXT NOT NULL,
        task_type VARCHAR(50) DEFAULT 'general',
        product_suggestion TEXT,
        is_weather_sensitive BOOLEAN DEFAULT false,
        skip_if_rain BOOLEAN DEFAULT false,
        priority VARCHAR(20) DEFAULT 'medium',
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      
      await pool.query(`CREATE TABLE IF NOT EXISTS farmer_crop_registrations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        farmer_id UUID NOT NULL,
        crop VARCHAR(100) NOT NULL,
        sow_date DATE NOT NULL,
        land_area NUMERIC(10,2),
        status VARCHAR(20) DEFAULT 'active',
        completed_stages JSONB DEFAULT '[]',
        next_reminder_date DATE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`);
      
      await pool.query(`CREATE TABLE IF NOT EXISTS crop_reminders_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        registration_id UUID NOT NULL,
        farmer_id UUID NOT NULL,
        template_id UUID,
        stage_name VARCHAR(200),
        message_sent TEXT,
        sent_at TIMESTAMP DEFAULT NOW(),
        farmer_response VARCHAR(50),
        responded_at TIMESTAMP,
        weather_context JSONB,
        status VARCHAR(20) DEFAULT 'sent'
      )`);

      // Seed default templates if empty
      const { rows } = await pool.query("SELECT COUNT(*) as cnt FROM crop_calendar_templates");
      if (parseInt(rows[0].cnt) === 0) {
        console.log("Seeding crop calendar templates...");
        const templates = [
          // WHEAT
          ['wheat', 'Germination Check', 5, 'Namaste! Aapke gehun ki buwai ko 5 din ho gaye. Kya ankuran aa gaya? Agar nahi aaya to mitti ki nami check karein.', 'Hello! 5 days since wheat sowing. Check if germination has started. If not, check soil moisture.', 'monitoring', null, false, false, 'high'],
          ['wheat', 'First Irrigation (Crown Root)', 21, 'Gehun mein pehli sinchai ka samay aa gaya hai (Crown Root stage). Halki sinchai karein - zyada paani mat dein.', 'Time for first irrigation (Crown Root stage). Give light irrigation - do not overwater.', 'irrigation', null, true, true, 'high'],
          ['wheat', 'Urea Top Dressing', 35, 'Gehun mein urea ki top dressing ka samay hai. 40-50 kg/acre urea dalein. Sinchai ke baad ya baarish ke pehle dalein.', 'Time for urea top dressing in wheat. Apply 40-50 kg/acre. Apply before irrigation or rain.', 'fertilization', 'Vartmaan Urea Plus', false, false, 'high'],
          ['wheat', 'Weed Management', 30, 'Gehun mein kharpatwar ki check karein. Agar zyada hain to 2,4-D spray karein ya haath se nikal dein.', 'Check for weeds in wheat. If heavy, spray 2,4-D or do manual weeding.', 'weeding', null, false, false, 'medium'],
          ['wheat', 'Second Irrigation', 40, 'Gehun mein doosri sinchai ka samay (tillering stage). Achhi sinchai dein.', 'Time for second irrigation (tillering stage). Give good irrigation.', 'irrigation', null, true, true, 'high'],
          ['wheat', 'Rust/Disease Watch', 55, 'Gehun mein peela/bhura rust ki jaanch karein. Pattiyon pe peele/bhure dhabe dikhein to turant fungicide spray karein.', 'Check wheat for yellow/brown rust. If you see spots on leaves, spray fungicide immediately.', 'pest_watch', 'Vartmaan Fungicide Pro', false, false, 'high'],
          ['wheat', 'Third Irrigation (Booting)', 65, 'Gehun mein teesri sinchai (booting stage). Yeh bahut zaroori hai - is samay paani ki kami se dano mein nuksan hota hai.', 'Third irrigation (booting stage). Very critical - water stress now reduces grain quality.', 'irrigation', null, true, true, 'critical'],
          ['wheat', 'Ear Head Stage Nutrition', 75, 'Gehun mein bali nikalne ka samay. Potash spray (1% KCl) se dano ki quality badhegi.', 'Wheat ear-head stage. Potash spray (1% KCl) will improve grain quality.', 'fertilization', 'Vartmaan Potash Plus', false, false, 'medium'],
          ['wheat', 'Fourth Irrigation (Grain Filling)', 85, 'Gehun mein chauthi sinchai (doodh stage). Halki sinchai dein - zyada paani se fasil gir sakti hai.', 'Fourth irrigation (milking stage). Give light irrigation - excess water can cause lodging.', 'irrigation', null, true, true, 'high'],
          ['wheat', 'Harvest Readiness Check', 115, 'Gehun ki katai ka samay aane wala hai! Dane sakht ho jayein aur nami 14% se kam ho to katai karein. Mandi bhav check karein.', 'Wheat harvest time approaching! When grains are hard and moisture below 14%, harvest. Check mandi prices.', 'harvest', null, false, false, 'critical'],
          ['wheat', 'Post Harvest Advisory', 120, 'Gehun ki katai ke baad - dhoop mein sukhayein, 12% nami tak. Storage mein kapde ki bori use karein. Mandi bhav: /mandi likhen.', 'Post harvest: dry in sun to 12% moisture. Use cloth bags for storage. Check mandi prices: type /mandi.', 'post_harvest', null, false, false, 'medium'],

          // RICE (Paddy)
          ['rice', 'Nursery Check', 7, 'Dhaan ki nursery ko 7 din hue. Kya paudhe 2-3 inch ke ho gaye? Paani ka level 1 inch rakhein.', 'Rice nursery is 7 days old. Are seedlings 2-3 inches? Keep water level at 1 inch.', 'monitoring', null, false, false, 'medium'],
          ['rice', 'Transplanting Reminder', 21, 'Dhaan ki nursery 21 din ki ho gayi. Ab khet mein ropai ka samay hai. 2-3 paudhe per hill lagayein.', 'Rice nursery is 21 days old. Time to transplant. Plant 2-3 seedlings per hill.', 'planting', null, false, false, 'critical'],
          ['rice', 'First Fertilizer', 28, 'Ropai ke 7 din baad - pehli khaad daalein. DAP 25 kg + Urea 20 kg per acre.', '7 days after transplanting - apply first fertilizer. DAP 25 kg + Urea 20 kg per acre.', 'fertilization', 'Vartmaan DAP Gold', false, false, 'high'],
          ['rice', 'Weed Control', 35, 'Dhaan mein kharpatwar ka dhyan dein. Butachlor spray ya haath se godi karein.', 'Watch for weeds in rice. Use Butachlor spray or manual weeding.', 'weeding', null, false, false, 'medium'],
          ['rice', 'Tillering Stage Urea', 45, 'Dhaan mein tiller banne ka samay. Urea 30 kg/acre dalein. Khet mein 2-3 cm paani rakhein.', 'Rice tillering stage. Apply Urea 30 kg/acre. Maintain 2-3 cm water in field.', 'fertilization', 'Vartmaan Urea Plus', false, false, 'high'],
          ['rice', 'Pest Watch (BPH/Stem Borer)', 55, 'Dhaan mein brown planthopper aur tana chedak ki jaanch karein. Peele patton ya sukhe tillon pe dhyan dein.', 'Check rice for BPH and stem borer. Watch for yellowing leaves or dead tillers.', 'pest_watch', 'Vartmaan Pest Shield', false, false, 'high'],
          ['rice', 'Panicle Stage Nutrition', 70, 'Dhaan mein bali nikalne ka samay. Potash 20 kg/acre daalein. Paani ka level maintain karein.', 'Rice panicle initiation. Apply Potash 20 kg/acre. Maintain water level.', 'fertilization', 'Vartmaan Potash Plus', false, false, 'high'],
          ['rice', 'Drain Field Before Harvest', 100, 'Dhaan ki katai 15-20 din mein hogi. Ab khet se paani nikal dein.', 'Rice harvest in 15-20 days. Drain the field now.', 'irrigation', null, false, false, 'medium'],
          ['rice', 'Harvest Time', 115, 'Dhaan ki katai ka samay! 80% dane pakk gaye hain. Subah ke samay katai karein. Mandi bhav check karein.', 'Rice harvest time! 80% grains are mature. Harvest in morning. Check mandi prices.', 'harvest', null, false, false, 'critical'],

          // SUGARCANE
          ['sugarcane', 'Germination Check', 15, 'Ganne ki buwai ko 15 din hue. Ankuran check karein. Agar kam hai to gap filling karein.', 'Sugarcane sowing is 15 days old. Check germination. Do gap filling if needed.', 'monitoring', null, false, false, 'high'],
          ['sugarcane', 'First Irrigation', 7, 'Ganne mein pehli sinchai karein. Halki sinchai - kood mein paani bharne dein.', 'Give first irrigation to sugarcane. Light irrigation - fill the furrows.', 'irrigation', null, true, true, 'high'],
          ['sugarcane', 'First Earthing Up', 45, 'Ganne mein pehli mitti chadhaane ka samay. Kharpatwar bhi saaf karein.', 'Time for first earthing up in sugarcane. Also clear weeds.', 'weeding', null, false, false, 'high'],
          ['sugarcane', 'Urea Application', 60, 'Ganne mein urea dalein - 60 kg/acre. Mitti chadhaane ke baad sinchai karein.', 'Apply urea in sugarcane - 60 kg/acre. Irrigate after earthing up.', 'fertilization', 'Vartmaan Urea Plus', false, false, 'high'],
          ['sugarcane', 'Second Earthing Up', 90, 'Ganne mein doosri baar mitti chadhaayein. Isse ganna girne se bachega.', 'Second earthing up in sugarcane. This prevents lodging.', 'weeding', null, false, false, 'medium'],
          ['sugarcane', 'Pest Check (Top Borer)', 75, 'Ganne mein top borer ki jaanch karein. Dead heart dikhne par turant spray karein.', 'Check for top borer in sugarcane. Spray immediately if dead hearts seen.', 'pest_watch', 'Vartmaan Pest Shield', false, false, 'high'],
          ['sugarcane', 'Grand Growth Nutrition', 120, 'Ganne ka grand growth phase. Potash 40 kg/acre + Zinc spray karein.', 'Sugarcane grand growth phase. Apply Potash 40 kg/acre + Zinc spray.', 'fertilization', 'Vartmaan Potash Plus', false, false, 'high'],
          ['sugarcane', 'Tying/Propping', 150, 'Ganne ko baandhne/support dene ka samay. 2-3 ganne ek saath baandhein.', 'Time to tie/prop sugarcane. Tie 2-3 canes together for support.', 'monitoring', null, false, false, 'medium'],
          ['sugarcane', 'Harvest Planning', 300, 'Ganne ki katai 30-60 din mein hogi. Sugar mill se sampark karein. Rassi bandh dein.', 'Sugarcane harvest in 30-60 days. Contact sugar mill. Tie the canes.', 'harvest', null, false, false, 'high'],

          // MUSTARD
          ['mustard', 'Germination Check', 5, 'Sarson ki buwai ko 5 din hue. Ankuran jaanch karein. Nami kami hai to halki sinchai dein.', 'Mustard sowing 5 days ago. Check germination. Light irrigation if moisture is low.', 'monitoring', null, false, false, 'medium'],
          ['mustard', 'Thinning', 20, 'Sarson mein chhatai karein - paudhon ke beech 15 cm jagah rakhein.', 'Thin mustard plants - maintain 15 cm spacing between plants.', 'monitoring', null, false, false, 'medium'],
          ['mustard', 'First Irrigation', 30, 'Sarson mein pehli sinchai ka samay (phool aane se pehle). Halki sinchai dein.', 'First irrigation for mustard (before flowering). Give light irrigation.', 'irrigation', null, true, true, 'high'],
          ['mustard', 'Aphid Watch', 45, 'Sarson mein mahu (aphid) ki jaanch karein. Peeli chippchipa keede dikhein to spray karein.', 'Check mustard for aphids. If you see sticky yellow insects, spray immediately.', 'pest_watch', 'Vartmaan Pest Shield', false, false, 'high'],
          ['mustard', 'Flowering Nutrition', 50, 'Sarson mein phool aa rahe hain. Boron spray (0.2%) se faliyan zyada aayengi.', 'Mustard is flowering. Boron spray (0.2%) will increase pod formation.', 'fertilization', null, false, false, 'medium'],
          ['mustard', 'Second Irrigation', 60, 'Sarson mein doosri sinchai (fali banne ka samay). Zaroori hai achhi paidawaar ke liye.', 'Second irrigation for mustard (pod formation). Essential for good yield.', 'irrigation', null, true, true, 'high'],
          ['mustard', 'Harvest Time', 110, 'Sarson ki katai ka samay! 75% faliyan peeli pad jayein to katai karein. Subah karein - dane girenge nahi.', 'Mustard harvest time! When 75% pods turn yellow, harvest in morning to avoid shattering.', 'harvest', null, false, false, 'critical'],

          // POTATO
          ['potato', 'Germination Check', 15, 'Aalu ki buwai ko 15 din hue. Kya paudhe nikal aaye? Agar nahi to mitti ki nami check karein.', 'Potato planting 15 days ago. Are sprouts showing? If not, check soil moisture.', 'monitoring', null, false, false, 'high'],
          ['potato', 'First Earthing Up', 25, 'Aalu mein pehli mitti chadhaane ka samay. Paudhon ke aas-paas mitti lagayein.', 'First earthing up for potato. Hill up soil around the plants.', 'weeding', null, false, false, 'high'],
          ['potato', 'First Irrigation', 10, 'Aalu mein pehli sinchai dein. Halki sinchai - waterlogging se bimari aati hai.', 'First irrigation for potato. Light irrigation - waterlogging causes disease.', 'irrigation', null, true, true, 'high'],
          ['potato', 'Urea Top Dressing', 30, 'Aalu mein urea ki top dressing karein - 35 kg/acre. Mitti chadhaane ke saath karein.', 'Urea top dressing for potato - 35 kg/acre. Apply with earthing up.', 'fertilization', 'Vartmaan Urea Plus', false, false, 'high'],
          ['potato', 'Late Blight Watch', 45, 'Aalu mein jhulsa (late blight) ki jaanch. Pattiyon pe kaale dhabe dikhein to Mancozeb spray karein.', 'Check potato for late blight. If black spots on leaves, spray Mancozeb immediately.', 'pest_watch', 'Vartmaan Fungicide Pro', false, false, 'critical'],
          ['potato', 'Second Earthing Up', 45, 'Aalu mein doosri mitti chadhaayein. Isse aalu hare nahi honge.', 'Second earthing up for potato. This prevents greening of tubers.', 'weeding', null, false, false, 'high'],
          ['potato', 'Haulm Cutting', 75, 'Aalu ki patti kaatne (dehaulming) ka samay. Katai ke 10-15 din baad khudai karein.', 'Time for haulm cutting in potato. Harvest 10-15 days after cutting.', 'monitoring', null, false, false, 'high'],
          ['potato', 'Harvest', 90, 'Aalu ki khudai ka samay! Dhoop mein 2-3 ghante sukhayein. Cold storage mein rakhein ya mandi bhejein.', 'Potato harvest time! Dry in sun for 2-3 hours. Store in cold storage or send to mandi.', 'harvest', null, false, false, 'critical']
        ];

        for (const t of templates) {
          await pool.query(
            "INSERT INTO crop_calendar_templates (crop, stage_name, day_offset, message_hi, message_en, task_type, product_suggestion, is_weather_sensitive, skip_if_rain, priority) VALUES (" + D + "1," + D + "2," + D + "3," + D + "4," + D + "5," + D + "6," + D + "7," + D + "8," + D + "9," + D + "10)",
            t
          );
        }
        console.log("Seeded " + templates.length + " crop calendar templates");
      }
    } catch(e) { console.log("Crop calendar table setup:", e.message); }
  })();

  // --- CROP CALENDAR API ROUTES ---

  // Get all templates (admin)
  app.get("/api/v1/crop-calendar/templates", auth, async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT * FROM crop_calendar_templates ORDER BY crop, day_offset");
      res.json({ templates: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Add/update template (admin)
  app.post("/api/v1/crop-calendar/templates", auth, async (req, res) => {
    try {
      const { crop, stage_name, day_offset, message_hi, message_en, task_type, product_suggestion, is_weather_sensitive, skip_if_rain, priority } = req.body;
      const { rows } = await pool.query(
        "INSERT INTO crop_calendar_templates (crop, stage_name, day_offset, message_hi, message_en, task_type, product_suggestion, is_weather_sensitive, skip_if_rain, priority) VALUES (" + D + "1," + D + "2," + D + "3," + D + "4," + D + "5," + D + "6," + D + "7," + D + "8," + D + "9," + D + "10) RETURNING *",
        [crop, stage_name, day_offset, message_hi, message_en, task_type || 'general', product_suggestion, is_weather_sensitive || false, skip_if_rain || false, priority || 'medium']
      );
      res.json({ template: rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Delete template
  app.delete("/api/v1/crop-calendar/templates/:id", auth, async (req, res) => {
    try {
      await pool.query("DELETE FROM crop_calendar_templates WHERE id=" + D + "1", [req.params.id]);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  
  // Manual table init endpoint (call once after deploy)
  app.get("/api/v1/crop-calendar/init-tables", async (req, res) => {
    try {
      // Create tables
      await pool.query(`
        CREATE TABLE IF NOT EXISTS crop_calendar_templates (
          id SERIAL PRIMARY KEY,
          crop VARCHAR(100) NOT NULL,
          stage_name VARCHAR(200) NOT NULL,
          day_offset INTEGER NOT NULL,
          message_hi TEXT,
          message_en TEXT,
          activity TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS farmer_crop_registrations (
          id SERIAL PRIMARY KEY,
          farmer_id UUID REFERENCES farmers(id),
          crop VARCHAR(100) NOT NULL,
          sow_date DATE NOT NULL,
          land_area DECIMAL,
          next_reminder_date DATE,
          status VARCHAR(20) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS crop_reminders_log (
          id SERIAL PRIMARY KEY,
          registration_id INTEGER REFERENCES farmer_crop_registrations(id),
          farmer_id UUID REFERENCES farmers(id),
          stage_name VARCHAR(200),
          message_sent TEXT,
          sent_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log("Crop calendar tables created");

      // Seed templates if empty
      const { rows: tCount } = await pool.query("SELECT COUNT(*) as cnt FROM crop_calendar_templates");
      if (parseInt(tCount[0].cnt) === 0) {
        const seeds = [
          ['wheat','Beej Upchar (Seed Treatment)',0,'Gehu ke beej ko Bavistin 2g/kg se upcharit karein.','Treat wheat seeds with Bavistin 2g/kg.','seed_treatment'],
          ['wheat','Pehli Sinchai',21,'Pehli sinchai 21 din baad karein (Crown Root stage).','First irrigation at 21 days.','irrigation'],
          ['wheat','Kharpatwar Niyantran',30,'Sulfosulfuron 25g/ha spray ya haath se nirai.','Spray Sulfosulfuron 25g/ha or manual weeding.','weed_control'],
          ['wheat','Doosri Sinchai',42,'Doosri sinchai 40-45 din par. Urea 1/3 dalein.','Second irrigation at 40-45 days. Apply 1/3 Urea.','irrigation'],
          ['wheat','Teesri Sinchai',65,'Teesri sinchai 60-65 din par. Potash spray karein.','Third irrigation at 60-65 days.','irrigation'],
          ['wheat','Rog Nighrani',75,'Peelay dhabe dikhein? Propiconazole 0.1% spray.','Yellow spots? Spray Propiconazole 0.1%.','disease_watch'],
          ['wheat','Katai',115,'Gehu 115-120 din mein taiyar. Nami 14% par katai.','Wheat ready 115-120 days. Harvest at 14% moisture.','harvest'],
          ['rice','Nursery Taiyari',0,'Nursery taiyar karein. Beej 24 ghante bhigoyein.','Prepare nursery. Soak seeds 24 hours.','nursery'],
          ['rice','Ropai',25,'25-30 din ki paudh ropai ke liye taiyar.','Seedlings ready at 25-30 days for transplanting.','transplanting'],
          ['rice','Kharpatwar Niyantran',35,'Ropai ke 7-10 din baad Butachlor dalein.','Apply Butachlor within 7-10 days of transplanting.','weed_control'],
          ['rice','Flowering',85,'Paani ki kami na ho. Blast dikhe to spray karein.','No water stress. Spray if blast appears.','flowering_care'],
          ['rice','Katai',120,'80% dane golden ho to katai karein.','Harvest when 80% grains golden.','harvest'],
          ['sugarcane','Buwai',0,'Sets ko Bavistin se treat karein. 90cm spacing.','Treat sets with Bavistin. 90cm spacing.','planting'],
          ['sugarcane','Mitti Chadhana',45,'Pehla kharpatwar niyantran aur mitti chadhana.','First weeding and earthing up.','earthing_up'],
          ['sugarcane','Borer Check',120,'5%+ infestation ho to Coragen spray.','If >5% borer, spray Coragen.','pest_control'],
          ['sugarcane','Katai',330,'11-12 mahine mein taiyar. Jaldi mill bhejein.','Ready 11-12 months. Send to mill quickly.','harvest']
        ];
        for (const s of seeds) {
          await pool.query("INSERT INTO crop_calendar_templates (crop,stage_name,day_offset,message_hi,message_en,activity) VALUES ($1,$2,$3,$4,$5,$6)", s);
        }
        console.log("Seeded", seeds.length, "templates");
      }

      // Add Fasal Calendar menu item if not exists
      const { rows: existing } = await pool.query("SELECT id FROM bot_menu_items WHERE menu_key='fasal_calendar'");
      if (existing.length === 0) {
        const { rows: maxOrder } = await pool.query("SELECT COALESCE(MAX(sort_order),0)+1 as next_order FROM bot_menu_items");
        await pool.query(
          "INSERT INTO bot_menu_items (menu_key, emoji, title_hi, title_en, description_hi, description_en, action_type, sort_order, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          ['fasal_calendar', '🌾', 'Fasal Calendar', 'Crop Calendar', 'Fasal register karein, growth reminders paayein', 'Register crop & get growth stage reminders', 'trigger', maxOrder[0].next_order, true]
        );
        console.log("Added Fasal Calendar menu item");
      }

      res.json({ success: true, message: "Tables created, templates seeded, menu item added" });
    } catch(e) {
      console.error("Init tables error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });



// Register farmer crop (from app or bot)
  app.post("/api/v1/crop-calendar/register", async (req, res) => {
    try {
      const { farmer_id, crop, sow_date, land_area } = req.body;
      if (!farmer_id || !crop || !sow_date) return res.status(400).json({ error: "farmer_id, crop, sow_date required" });
      
      // Calculate next reminder date
      const { rows: templates } = await pool.query(
        "SELECT MIN(day_offset) as first_day FROM crop_calendar_templates WHERE LOWER(crop)=LOWER(" + D + "1)", [crop]
      );
      const firstDay = templates[0] ? templates[0].first_day : 5;
      const nextDate = new Date(sow_date);
      nextDate.setDate(nextDate.getDate() + firstDay);

      const { rows } = await pool.query(
        "INSERT INTO farmer_crop_registrations (farmer_id, crop, sow_date, land_area, next_reminder_date) VALUES (" + D + "1," + D + "2," + D + "3," + D + "4," + D + "5) RETURNING *",
        [farmer_id, crop.toLowerCase(), sow_date, land_area || null, nextDate.toISOString().split('T')[0]]
      );
      res.json({ registration: rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Get farmer registrations
  app.get("/api/v1/crop-calendar/farmer/:farmerId", async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT r.*, (SELECT COUNT(*) FROM crop_reminders_log WHERE registration_id=r.id) as reminders_sent FROM farmer_crop_registrations r WHERE r.farmer_id=" + D + "1 ORDER BY r.created_at DESC",
        [req.params.farmerId]
      );
      res.json({ registrations: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Get timeline for a registration
  app.get("/api/v1/crop-calendar/timeline/:regId", async (req, res) => {
    try {
      const { rows: [reg] } = await pool.query("SELECT * FROM farmer_crop_registrations WHERE id=" + D + "1", [req.params.regId]);
      if (!reg) return res.status(404).json({ error: "Not found" });

      const { rows: templates } = await pool.query(
        "SELECT * FROM crop_calendar_templates WHERE LOWER(crop)=LOWER(" + D + "1) ORDER BY day_offset", [reg.crop]
      );

      const { rows: logs } = await pool.query(
        "SELECT * FROM crop_reminders_log WHERE registration_id=" + D + "1 ORDER BY sent_at", [req.params.regId]
      );

      const sowDate = new Date(reg.sow_date);
      const today = new Date();
      const daysSinceSow = Math.floor((today - sowDate) / (1000 * 60 * 60 * 24));

      const timeline = templates.map(t => {
        const dueDate = new Date(sowDate);
        dueDate.setDate(dueDate.getDate() + t.day_offset);
        const sent = logs.find(l => l.template_id === t.id);
        return {
          ...t,
          due_date: dueDate.toISOString().split('T')[0],
          status: sent ? (sent.farmer_response === 'done' ? 'completed' : 'sent') : (t.day_offset <= daysSinceSow ? 'overdue' : 'upcoming'),
          sent_at: sent ? sent.sent_at : null,
          farmer_response: sent ? sent.farmer_response : null
        };
      });

      res.json({ registration: reg, timeline, days_since_sow: daysSinceSow });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Admin overview of all registrations
  app.get("/api/v1/crop-calendar/overview", auth, async (req, res) => {
    try {
      const { rows: stats } = await pool.query(`
        SELECT 
          COUNT(*) as total_registrations,
          COUNT(CASE WHEN status='active' THEN 1 END) as active,
          COUNT(DISTINCT farmer_id) as unique_farmers,
          COUNT(DISTINCT crop) as unique_crops
        FROM farmer_crop_registrations
      `);
      
      const { rows: byCrop } = await pool.query(`
        SELECT crop, COUNT(*) as count, COUNT(CASE WHEN status='active' THEN 1 END) as active
        FROM farmer_crop_registrations GROUP BY crop ORDER BY count DESC
      `);

      const { rows: upcoming } = await pool.query(`
        SELECT r.*, f.name as farmer_name, f.phone as farmer_phone,
          (SELECT stage_name FROM crop_calendar_templates t WHERE LOWER(t.crop)=LOWER(r.crop) AND t.day_offset >= EXTRACT(DAY FROM NOW()-r.sow_date)::int ORDER BY t.day_offset LIMIT 1) as next_stage
        FROM farmer_crop_registrations r
        JOIN farmers f ON f.id = r.farmer_id
        WHERE r.status='active' AND r.next_reminder_date <= CURRENT_DATE + INTERVAL '3 days'
        ORDER BY r.next_reminder_date
        LIMIT 20
      `);

      const { rows: recentLogs } = await pool.query(`
        SELECT l.*, f.name as farmer_name, r.crop
        FROM crop_reminders_log l
        JOIN farmers f ON f.id = l.farmer_id
        JOIN farmer_crop_registrations r ON r.id = l.registration_id
        ORDER BY l.sent_at DESC LIMIT 20
      `);

      res.json({ stats: stats[0], byCrop, upcoming, recentLogs });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Mark reminder response
  app.post("/api/v1/crop-calendar/response/:logId", async (req, res) => {
    try {
      const { response } = req.body;
      await pool.query(
        "UPDATE crop_reminders_log SET farmer_response=" + D + "1, responded_at=NOW() WHERE id=" + D + "2",
        [response, req.params.logId]
      );
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });


};