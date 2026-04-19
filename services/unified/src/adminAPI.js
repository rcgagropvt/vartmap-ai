// VartMap Admin API Routes Module
const bcrypt = require('bcryptjs');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const QRCode = require('qrcode');

module.exports = function setupAdminAPI(app, pool) {







  
  
  
  
  // â”€â”€â”€ AUTH MIDDLEWARE â”€â”€â”€
  const auth = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  };
  
  // â”€â”€â”€ HEALTH â”€â”€â”€
  app.get('/health', async (req, res) => {
    try {
      const r = await pool.query('SELECT NOW()');
      res.json({ status: 'healthy', service: 'admin-api', timestamp: r.rows[0].now, database: 'connected' });
    } catch (e) { res.status(500).json({ status: 'unhealthy', error: e.message }); }
  });
  
  // â”€â”€â”€ AUTH â”€â”€â”€
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
  
  // â”€â”€â”€ DASHBOARD â”€â”€â”€
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
  
  
  // â”€â”€â”€ FARMERS (Full CRUD) â”€â”€â”€
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
      res.json({ farmer: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // â”€â”€â”€ WHATSAPP CHAT (Full CRM) â”€â”€â”€
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
  
  
  // â”€â”€â”€ TEMPLATES (Full CRUD) â”€â”€â”€
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
  
  // â”€â”€â”€ META TEMPLATE MANAGEMENT API â”€â”€â”€
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
  
  // â”€â”€â”€ CAMPAIGNS (BROADCAST) â”€â”€â”€
  
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
        // Retarget campaign â€” use specific farmer IDs
        const idPlaceholders = criteria.farmer_ids.map((_, i) => '$' + (i + 1)).join(',');
        farmers = await pool.query(
          `SELECT f.id, f.phone, f.name, f.crops, f.village FROM farmers f WHERE f.id IN (${idPlaceholders}) AND f.status='active' AND f.phone IS NOT NULL`,
          criteria.farmer_ids
        );
      } else {
        // Normal campaign â€” use filters
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
            message: `ðŸŽ‰ Hi ${farmer.rows[0].name}! Your redemption request for "${item.rows[0]?.name}" has been approved! We'll process it shortly. Ref: ${req.params.id.slice(0,8)}`
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
  
  // â”€â”€â”€ SPIN WHEELS (Digicides-style) â”€â”€â”€
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
  // â”€â”€â”€ COUPON CODES â”€â”€â”€
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
          message: `âœ… Coupon ${c.code} redeemed successfully!\n\nðŸŽ ${c.campaign_name}\nðŸ’° ${c.discount_type === 'percentage' ? c.discount_value + '% discount' : c.discount_type === 'points' ? c.discount_value + ' loyalty points' : 'â‚¹' + c.discount_value + ' off'}\n\nThank you for your purchase! ðŸŒ¾`
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
  // â”€â”€â”€ QR CODE GENERATION â”€â”€â”€
  const QRCode = require('qrcode');
  
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
  
  // â”€â”€â”€ DEALER ASSIGNMENT â”€â”€â”€
  
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
              message: `ðŸŽ« VartMap Coupon Assignment\n\nDear ${dealer_name},\n${codes_count} coupon codes have been assigned to you.\n\nPlease distribute these to farmers along with product sales.\n\nThank you for your partnership!`
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
  
  // â”€â”€â”€ BULK DISTRIBUTION â”€â”€â”€
  
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
            : `ðŸŽ Namaste ${f.name || 'Farmer'}!\n\nYou have a special offer from VartMap:\nðŸŽ« Code: *${code.code}*\nðŸ’° Discount: ${discountText}\nðŸ“¦ Campaign: ${camp.name}\n\nTo redeem, simply reply with your code or show it at your dealer.\n\nHappy farming! ðŸŒ¾`;
  
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
  
  // â”€â”€â”€ GEO-TRACKED REDEMPTION â”€â”€â”€
  
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
            message: `âœ… Coupon Redeemed!\n\nHi ${farmerName}, your code *${code.toUpperCase()}* has been successfully redeemed.\nðŸŽ Reward: ${discountText}\nðŸ“¦ Campaign: ${c.campaign_name}\n\nThank you for choosing VartMap! ðŸŒ¾`
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
  
  // â”€â”€â”€ SOIL NUTRIENT DATA â”€â”€â”€
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
  
  // â”€â”€â”€ REWARDS (Points-based) â”€â”€â”€
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
  
  // â”€â”€â”€ REFERRALS â”€â”€â”€
  app.get('/api/v1/referrals', auth, async (req, res) => {
    try {
      const codes = await pool.query('SELECT rc.*, f.name as farmer_name, f.phone FROM referral_codes rc LEFT JOIN farmers f ON rc.farmer_id=f.id ORDER BY rc.created_at DESC');
      const refs = await pool.query('SELECT r.*, f1.name as referrer_name, f2.name as referee_name FROM referrals r LEFT JOIN farmers f1 ON r.referrer_id=f1.id LEFT JOIN farmers f2 ON r.referee_id=f2.id ORDER BY r.created_at DESC LIMIT 100');
      res.json({ codes: codes.rows, referrals: refs.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // â”€â”€â”€ GOVERNMENT SCHEMES â”€â”€â”€
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
  
  // â”€â”€â”€ PRODUCTS â”€â”€â”€
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
  
  // â”€â”€â”€ MANDI PRICES â”€â”€â”€
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
  
  // â”€â”€â”€ MODERATION â”€â”€â”€
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
  
  // â”€â”€â”€ ORDERS â”€â”€â”€
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
  
  // â”€â”€â”€ DEALERS â”€â”€â”€
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
  
  // â”€â”€â”€ FIELD AGENTS â”€â”€â”€
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
  
  // â”€â”€â”€ NOTIFICATIONS LOG â”€â”€â”€
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
  
  // â”€â”€â”€ ANALYTICS â”€â”€â”€
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
  
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ADVANCED ANALYTICS ENDPOINTS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  
  // GET /api/v1/analytics/campaigns â€” Campaign performance summary
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
  
  // GET /api/v1/analytics/farmers â€” Farmer engagement analytics
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
  
  // GET /api/v1/analytics/templates â€” Template performance comparison
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
  
  // GET /api/v1/analytics/geographic â€” District-level engagement heatmap data
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
  
  // GET /api/v1/analytics/conversations â€” WhatsApp conversation analytics
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
  
  // POST /api/v1/analytics/refresh-engagement â€” Recalculate farmer engagement scores
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
  
  // GET /api/v1/analytics/roi â€” Cost & ROI analytics
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
  
  
  // â”€â”€â”€ DISTRICTS â”€â”€â”€
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
  
  // â”€â”€â”€ AUDIT LOG â”€â”€â”€
  app.get('/api/v1/audit-log', auth, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100');
      res.json({ logs: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  
  // â”€â”€â”€ ADMIN USERS â”€â”€â”€
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
  // â”€â”€â”€ PROXY: Fetch Live Data from Intelligence Service â”€â”€â”€
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
  // â”€â”€â”€ PRIZE FULFILLMENT (Digicides-style Admin Flow) â”€â”€â”€
  
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
          msg = `âœ… Prize Approved!\n\nHi ${p.farmer_name}, your cash prize of â‚¹${p.prize_value} from the lucky draw has been approved!\n\nPlease reply with your UPI ID (e.g. name@upi) to receive the payment.\n\nRef: ${p.verification_code || p.id.slice(0,8)}\n\nðŸŒ¾ VartMap Krishi Sahayak`;
        } else if (p.prize_type === 'discount') {
          msg = `âœ… Prize Approved!\n\nHi ${p.farmer_name}, you won a ${p.prize_value}% discount!\n\nðŸ·ï¸ Your Coupon Code: *${couponCode}*\n\nShow this code to your nearest dealer to avail the discount.\n\nRef: ${p.verification_code || p.id.slice(0,8)}\n\nðŸŒ¾ VartMap Krishi Sahayak`;
        } else if (p.prize_type === 'points') {
          msg = `âœ… Prize Approved!\n\nHi ${p.farmer_name}, ${p.prize_value} loyalty points have been added to your account!\n\nTotal points will be visible in your next interaction.\n\nRef: ${p.verification_code || p.id.slice(0,8)}\n\nðŸŒ¾ VartMap Krishi Sahayak`;
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
        const msg = `Hi ${p.farmer_name}, unfortunately your prize claim could not be verified.\n\nReason: ${reason}\n\nPlease contact support for help.\n\nðŸŒ¾ VartMap Krishi Sahayak`;
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
          msg = `ðŸ’° Payment Sent!\n\nHi ${p.farmer_name}, â‚¹${p.prize_value} has been sent to your account!\n\nMethod: ${payment_method || 'UPI'}\nRef: ${payment_reference || p.id.slice(0,8)}\n\nThank you for participating! ðŸŒ¾ VartMap Krishi Sahayak`;
        } else {
          msg = `ðŸŽ Prize Delivered!\n\nHi ${p.farmer_name}, your prize "${p.prize_label || p.prize_type}" has been marked as delivered.\n\nRef: ${payment_reference || p.id.slice(0,8)}\n\nThank you! ðŸŒ¾ VartMap Krishi Sahayak`;
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
  
  // â”€â”€â”€ PUBLIC SPIN WHEEL API (No auth required - Digicides-style flow) â”€â”€â”€
  
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
          const msg = `ðŸŽ‰ Congratulations! You won "${selectedSegment.label}" in the ${wheel.name} lucky draw!\n\nReference: ${refId}\nPrize will be credited within 24 hours.\n\nðŸŒ¾ VartMap Krishi Sahayak`;
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
      const existingFarmer = await pool.query('SELECT * FROM farmers WHERE phone=$1', [cleanPhone]);
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
  
  // â”€â”€â”€ CROP RECOMMENDATIONS â”€â”€â”€
  
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
  
  // â”€â”€â”€ AI CATALOG ENDPOINT (for WhatsApp bot) â”€â”€â”€
  
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
  
  // â”€â”€â”€ START SERVER â”€â”€â”€
};
