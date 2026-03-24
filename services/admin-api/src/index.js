const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auth middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Health check
app.get('/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW()');
    res.json({
      status: 'healthy',
      service: 'admin-api',
      timestamp: dbResult.rows[0].now,
      database: 'connected'
    });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// Login
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM admin_users WHERE email = $1 AND status = $2', [email, 'active']);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    await pool.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard stats
app.get('/api/v1/dashboard', authenticate, async (req, res) => {
  try {
    const farmers = await pool.query('SELECT COUNT(*) FROM farmers');
    const conversations = await pool.query('SELECT COUNT(*) FROM conversations WHERE created_at > NOW() - INTERVAL \'24 hours\'');
    const activeToday = await pool.query('SELECT COUNT(DISTINCT farmer_id) FROM conversations WHERE created_at > NOW() - INTERVAL \'24 hours\'');

    res.json({
      total_farmers: parseInt(farmers.rows[0].count),
      conversations_24h: parseInt(conversations.rows[0].count),
      active_farmers_24h: parseInt(activeToday.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List farmers
app.get('/api/v1/farmers', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const result = await pool.query(
      'SELECT id, phone, bsu_id, name, language, village, crops, onboarding_stage, status, created_at FROM farmers ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    const total = await pool.query('SELECT COUNT(*) FROM farmers');
    res.json({ farmers: result.rows, total: parseInt(total.rows[0].count), limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Admin API running on port ${PORT}`);
});
