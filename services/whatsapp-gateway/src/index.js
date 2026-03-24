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
let pool = null;
try {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && dbUrl !== 'placeholder') {
    pool = new Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pool.on('error', (err) => console.error('DB pool error:', err.message));
    console.log('Database pool created');
  }
} catch (err) {
  console.error('DB init error:', err.message);
}

// Redis connection (Upstash compatible)
let redis = null;
try {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl && redisUrl !== 'placeholder') {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      reconnectOnError(err) {
        return err.message.includes('READONLY');
      },
      tls: {},
      lazyConnect: true
    });
    redis.on('error', (err) => console.error('Redis error:', err.message));
    redis.on('connect', () => console.log('Redis connected'));
    redis.connect().catch((err) => console.error('Redis connect failed:', err.message));
  }
} catch (err) {
  console.error('Redis init error:', err.message);
}

// Health check
app.get('/health', async (req, res) => {
  let dbStatus = 'not configured';
  let dbTime = null;
  try {
    if (pool) {
      const result = await pool.query('SELECT NOW()');
      dbStatus = 'connected';
      dbTime = result.rows[0].now;
    }
  } catch (err) {
    dbStatus = 'error: ' + err.message;
  }

  let redisStatus = 'not configured';
  try {
    if (redis) {
      await redis.ping();
      redisStatus = 'connected';
    }
  } catch (err) {
    redisStatus = 'error: ' + err.message;
  }

  res.json({
    status: dbStatus === 'connected' ? 'healthy' : 'degraded',
    service: 'whatsapp-gateway',
    timestamp: dbTime,
    database: dbStatus,
    redis: redisStatus
  });
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

    if (body.object === 'whatsapp_business_account' && pool) {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.value.messages) {
            for (const message of change.value.messages) {
              console.log('Message from:', message.from, 'Text:', message.text?.body);

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
