const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const Redis = require('ioredis');
const axios = require('axios');

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

// Redis connection
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

// ============================================
// WhatsApp Cloud API - Send Message
// ============================================
async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const accessToken = process.env.WA_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.error('Missing WA_PHONE_NUMBER_ID or WA_ACCESS_TOKEN');
    return null;
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  try {
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: { body: text }
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Message sent successfully to', to);
    return response.data;
  } catch (err) {
    console.error('Send message error:', err.response?.data || err.message);
    return null;
  }
}

// ============================================
// Send message from Admin Dashboard
// ============================================
app.post('/api/v1/send-message', async (req, res) => {
  try {
    const { phone, message, session_id, farmer_id } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message are required' });
    }

    const result = await sendWhatsAppMessage(phone, message);

    if (!result) {
      return res.status(500).json({ error: 'Failed to send WhatsApp message' });
    }

    // Store outgoing message with correct column names
    if (session_id && pool) {
      await pool.query(
        `INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())`,
        [session_id, farmer_id || null, message]
      );

      await pool.query(
        'UPDATE wa_chat_sessions SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1',
        [session_id]
      );
    }

    res.json({ success: true, wa_response: result });
  } catch (err) {
    console.error('Send message API error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body.object || body.object !== 'whatsapp_business_account') return;

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const messages = value.messages || [];
        const contacts = value.contacts || [];

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const contact = contacts[i] || {};
          const from = msg.from;
          const msgBody = msg.text?.body || '';
          const profileName = contact.profile?.name || 'Unknown';
          const waMessageId = msg.id;

          console.log(`Incoming from ${from} (${profileName}): ${msgBody}`);

          if (!pool) {
            console.error('No database connection');
            continue;
          }

          // 1. Find or create farmer
          let farmer = await pool.query('SELECT * FROM farmers WHERE phone = $1', [from]);

          if (farmer.rows.length === 0) {
            farmer = await pool.query(
              `INSERT INTO farmers (id, name, phone, language, status, onboarding_stage, profile_complete, total_interactions, created_at, updated_at)
               VALUES (gen_random_uuid(), $1, $2, 'hi', 'active', 'new', false, 1, NOW(), NOW())
               RETURNING *`,
              [profileName, from]
            );
            console.log('New farmer created:', from);
          } else {
            await pool.query(
              'UPDATE farmers SET total_interactions = COALESCE(total_interactions, 0) + 1, last_interaction_at = NOW(), updated_at = NOW() WHERE phone = $1',
              [from]
            );
          }

          const farmerId = farmer.rows[0].id;

          // 2. Find or create chat session
          let session = await pool.query(
            'SELECT * FROM wa_chat_sessions WHERE farmer_id = $1 AND status = $2',
            [farmerId, 'active']
          );

          if (session.rows.length === 0) {
            session = await pool.query(
              `INSERT INTO wa_chat_sessions (id, farmer_id, status, last_message_at, created_at, updated_at)
               VALUES (gen_random_uuid(), $1, 'active', NOW(), NOW(), NOW())
               RETURNING *`,
              [farmerId]
            );
          }

          const sessionId = session.rows[0].id;

          await pool.query(
            'UPDATE wa_chat_sessions SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1',
            [sessionId]
          );

          // 3. Store incoming message — CORRECT COLUMNS
          await pool.query(
            `INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_message_id, wa_status, created_at)
             VALUES (gen_random_uuid(), $1, $2, 'inbound', 'farmer', 'text', $3, $4, 'delivered', NOW())`,
            [sessionId, farmerId, msgBody, waMessageId]
          );

          console.log('Message stored for farmer', farmerId);
          // ─── COUPON CODE DETECTION ───
// Detect if the message looks like a coupon code (alphanumeric, 8-20 chars, may have a prefix)
const couponMatch = msgBody.trim().match(/^[A-Z0-9]{6,20}$/i);
if (couponMatch) {
  try {
    const adminApiUrl = process.env.ADMIN_API_URL || 'https://vartmap-admin-api.onrender.com';
    const validateResp = await fetch(`${adminApiUrl}/api/v1/coupons/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: couponMatch[0] })
    });
    const validateData = await validateResp.json();

    if (validateResp.ok && validateData.valid) {
      // Auto-redeem the code
      const redeemResp = await fetch(`${adminApiUrl}/api/v1/coupons/redeem-geo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: couponMatch[0], phone: from.replace("@s.whatsapp.net","") })
      });
      const redeemData = await redeemResp.json();

      if (redeemResp.ok && redeemData.redeemed) {
        const discountText = redeemData.discount_type === 'percentage' ? redeemData.discount_value + '% discount' :
                             redeemData.discount_type === 'points' ? redeemData.discount_value + ' loyalty points' :
                             'Rs.' + redeemData.discount_value + ' discount';
        replyMessage = `✅ *Coupon Redeemed Successfully!*\n\n🎫 Code: *${couponMatch[0].toUpperCase()}*\n🎁 Reward: ${discountText}\n📦 Campaign: ${redeemData.campaign_name}\n\nYour reward has been applied. Thank you! 🌾`;
      } else {
        replyMessage = `⚠️ This code *${couponMatch[0].toUpperCase()}* ${redeemData.error || 'could not be redeemed'}. Please check and try again.`;
      }

      // Send the reply and skip further processing
      await sendWhatsAppMessage(from, replyMessage);
      return res.sendStatus(200);
    }
    // If not a valid coupon, fall through to normal message processing
  } catch (e) {
    console.log('Coupon validation error:', e.message);
    // Fall through to normal processing
  }
}
          // 4. Auto-reply
          const msgCount = await pool.query(
            "SELECT COUNT(*) FROM wa_messages WHERE session_id = $1 AND direction = 'inbound'",
            [sessionId]
          );

          let replyText;
          if (parseInt(msgCount.rows[0].count) <= 1) {
            replyText = `🙏 Namaste ${profileName}!\n\nWelcome to VartMap Krishi Sahayak. I'm here to help you with:\n\n🌾 Mandi Prices\n🧪 Soil Health Info\n💰 Government Schemes\n🌤 Weather Updates\n\nHow can I help you today?`;
          } else {
            replyText = `Thank you for your message! Our team will respond shortly. 🙏`;
          }

          const sendResult = await sendWhatsAppMessage(from, replyText);

          // Store auto-reply — CORRECT COLUMNS
          await pool.query(
            `INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at)
             VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, $4, NOW())`,
            [sessionId, farmerId, replyText, sendResult ? 'sent' : 'failed']
          );

          console.log(`Reply ${sendResult ? 'sent' : 'FAILED'} to ${from}`);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

// API routes
app.get('/api/v1/status', (req, res) => {
  res.json({ status: 'running', service: 'whatsapp-gateway', version: '1.0.0' });
});

app.listen(PORT, () => {
  console.log(`WhatsApp Gateway running on port ${PORT}`);
});
