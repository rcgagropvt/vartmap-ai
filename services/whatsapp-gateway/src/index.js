const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Redis connection
let redis = null;
try {
  if (process.env.REDIS_URL && process.env.REDIS_URL !== 'placeholder') {
    redis = new Redis(process.env.REDIS_URL);
    redis.on('error', (err) => console.error('Redis error:', err.message));
    redis.on('connect', () => console.log('Redis connected'));
  }
} catch (err) {
  console.error('Redis init error:', err.message);
}

// Health check
app.get('/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW()');
    res.json({
      status: 'healthy',
      service: 'whatsapp-gateway',
      timestamp: dbResult.rows[0].now,
      database: 'connected',
      redis: redis ? 'connected' : 'not configured'
    });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// WhatsApp webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// WhatsApp webhook incoming messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Incoming webhook:', JSON.stringify(body).substring(0, 500));

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.value.messages) {
            for (const message of change.value.messages) {
              console.log('Message from:', message.from, 'Text:', message.text?.body);
              
              // Store conversation
              await pool.query(
                `INSERT INTO conversations (farmer_id, channel, direction, message_type, content, wa_message_id, created_at)
                 SELECT f.id, 'whatsapp', 'inbound', $1, $2, $3, NOW()
                 FROM farmers f WHERE f.phone = $4
                 LIMIT 1`,
                [message.type || 'text', message.text?.body || '', message.id, message.from]
              );
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(200);
  }
});

// API routes
app.get('/api/v1/status', (req, res) => {
  res.json({ status: 'running', service: 'whatsapp-gateway', version: '1.0.0' });
});

// Start server
app.listen(PORT, () => {
  console.log(`WhatsApp Gateway running on port ${PORT}`);
});
