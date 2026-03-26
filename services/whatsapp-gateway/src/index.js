const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));

// --- DATABASE ---
const dbUrl = process.env.DATABASE_URL;
let pool = null;
if (dbUrl) {
  pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, max: 5 });
  pool.on('error', (err) => console.error('DB pool error:', err));
  console.log('Database pool created');
} else {
  console.warn('DATABASE_URL not set');
}

// --- REDIS (optional) ---
let redis = null;
try {
  const Redis = require('ioredis');
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 3, retryStrategy: (times) => Math.min(times * 200, 5000) });
    redis.on('error', (err) => console.error('Redis error:', err.message));
    redis.on('connect', () => console.log('Redis connected'));
  }
} catch (e) { console.log('Redis not available:', e.message); }

// --- GEMINI AI ---
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
let catalogCache = null;
let catalogCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getProductCatalog() {
  const now = Date.now();
  if (catalogCache && (now - catalogCacheTime) < CACHE_TTL) return catalogCache;
  try {
    const adminApiUrl = process.env.ADMIN_API_URL || 'https://vartmap-admin-api.onrender.com';
    const resp = await axios.get(adminApiUrl + '/api/v1/catalog/ai-context');
    catalogCache = resp.data;
    catalogCacheTime = now;
    return catalogCache;
  } catch (e) {
    console.error('Failed to fetch catalog:', e.message);
    return catalogCache || { brand: 'Vartmaan Fertilizers', company: 'RCG Agro Pvt Ltd', products: [], recommendations: [] };
  }
}

function buildSystemPrompt(catalog, farmer, language) {
  const productList = (catalog.products || []).map(p =>
    `- ${p.product_name} (${p.product_code}): ${p.composition}. Crops: ${(p.target_crops || []).join(', ')}. ${p.benefits || ''} Dosage: ${p.dosage_per_acre || 'as per soil test'}`
  ).join('\n');

  const recoList = (catalog.recommendations || []).map(r =>
    `- ${r.crop_name} / ${r.growth_stage} (${r.days_range || ''}): Use ${r.product_name} - ${r.dosage}. Method: ${r.application_method || 'soil application'}`
  ).join('\n');

  const langInstruction = language === 'hi'
    ? 'Respond in Hindi (Devanagari script). If the farmer writes in English, still reply in Hindi unless they explicitly ask for English.'
    : language === 'en'
    ? 'Respond in English.'
    : 'Detect the language the farmer is using and respond in the same language. If mixed Hindi-English (Hinglish), respond in Hindi.';

  return `You are "VartMap Krishi Sahayak" - an AI agricultural assistant for Indian farmers, powered by Vartmaan Fertilizers (RCG Agro Private Limited).

ROLE:
- You are a helpful, knowledgeable agricultural advisor who speaks like a friendly local expert
- You recommend Vartmaan Fertilizers products when relevant (never push products unnecessarily)
- You help with crop advice, soil health, pest/disease identification, weather guidance, government schemes, and mandi prices
- Keep responses concise (under 300 words) since this is WhatsApp - use short paragraphs, not long essays
- Use simple language that farmers understand

LANGUAGE:
${langInstruction}

FARMER CONTEXT:
- Name: ${farmer.name || 'Kisan'}
- Phone: ${farmer.phone || 'unknown'}
- Village: ${farmer.village || 'unknown'}
- State: ${farmer.state || 'unknown'}
- Primary Crop: ${farmer.primary_crop || 'unknown'}
- Soil Type: ${farmer.soil_type || 'unknown'}

VARTMAAN FERTILIZERS PRODUCT CATALOG:
${productList || 'No products loaded'}

CROP-SPECIFIC RECOMMENDATIONS:
${recoList || 'No specific recommendations loaded'}

GUIDELINES:
1. When a farmer mentions a crop + problem/stage, recommend the most relevant Vartmaan product with exact dosage
2. For zinc deficiency: recommend VARTIZIN products
3. For iron deficiency/chlorosis: recommend VARTIFER products  
4. For sugarcane: recommend VARTIMIX Ganna Special 10%
5. For general micronutrient needs: recommend VARTIMIX Multi-Crop 6% or Balshali 4%
6. For premium/alkaline soil needs: recommend Kavach (chelated) variants
7. If you do not know something, say so honestly - do not make up information
8. For pest/disease images, describe what you see and suggest treatment
9. Always be respectful and address the farmer warmly
10. If asked about prices, say "Please contact your nearest dealer or call our helpline"
11. Do not discuss competitor products by name
12. For emergency pest attacks, advise contacting local Krishi Vigyan Kendra (KVK)`;
}

async function getChatHistory(farmerId, limit) {
  if (!pool) return [];
  try {
    const r = await pool.query(
      'SELECT role, content FROM ai_chat_history WHERE farmer_id=$1 ORDER BY created_at DESC LIMIT $2',
      [farmerId, limit || 10]
    );
    return r.rows.reverse();
  } catch (e) { return []; }
}

async function saveChatHistory(farmerId, sessionId, role, content, lang, model) {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO ai_chat_history (id, farmer_id, session_id, role, content, language, model, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())',
      [farmerId, sessionId, role, content, lang || 'hi', model || 'gemini-2.0-flash']
    );
  } catch (e) { console.error('Save chat history error:', e.message); }
}

async function getAIResponse(farmerId, sessionId, farmer, messageText, messageType, mediaUrl) {
  if (!genAI) {
    return 'AI service is not configured. Our team will respond shortly.';
  }

  try {
    const catalog = await getProductCatalog();
    const detectedLang = /[\u0900-\u097F]/.test(messageText) ? 'hi' : 'en';
    const systemPrompt = buildSystemPrompt(catalog, farmer, detectedLang);
    const history = await getChatHistory(farmerId, 8);

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const chatMessages = [];
    chatMessages.push({ role: 'user', parts: [{ text: 'System instructions: ' + systemPrompt }] });
    chatMessages.push({ role: 'model', parts: [{ text: 'Understood. I am VartMap Krishi Sahayak, ready to help farmers with agricultural advice and Vartmaan Fertilizers product recommendations.' }] });

    for (const h of history) {
      chatMessages.push({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: h.content }]
      });
    }

    let userParts = [];

    if (messageType === 'image' && mediaUrl) {
      try {
        const imgResp = await axios.get(mediaUrl, {
          headers: { 'Authorization': 'Bearer ' + process.env.WA_ACCESS_TOKEN },
          responseType: 'arraybuffer'
        });
        const base64 = Buffer.from(imgResp.data).toString('base64');
        const mimeType = imgResp.headers['content-type'] || 'image/jpeg';
        userParts.push({ inlineData: { data: base64, mimeType: mimeType } });
        userParts.push({ text: messageText || 'Please analyze this crop/plant image. Identify any disease, pest damage, or nutrient deficiency. Recommend treatment using Vartmaan Fertilizers products if applicable.' });
      } catch (imgErr) {
        console.error('Image download error:', imgErr.message);
        userParts.push({ text: messageText || 'The farmer sent an image but I could not load it. Please ask them to describe the problem.' });
      }
    } else if (messageType === 'audio' && mediaUrl) {
      try {
        const audioResp = await axios.get(mediaUrl, {
          headers: { 'Authorization': 'Bearer ' + process.env.WA_ACCESS_TOKEN },
          responseType: 'arraybuffer'
        });
        const base64 = Buffer.from(audioResp.data).toString('base64');
        const mimeType = audioResp.headers['content-type'] || 'audio/ogg';
        userParts.push({ inlineData: { data: base64, mimeType: mimeType } });
        userParts.push({ text: 'The farmer sent a voice message. Please listen to it, understand their question (it may be in Hindi, Marathi, Telugu, Tamil, or another Indian language), and respond helpfully in the same language they spoke.' });
      } catch (audioErr) {
        console.error('Audio download error:', audioErr.message);
        userParts.push({ text: 'The farmer sent a voice note but I could not load it. Ask them to type their question instead.' });
      }
    } else {
      userParts.push({ text: messageText });
    }

    chatMessages.push({ role: 'user', parts: userParts });

    const chat = model.startChat({ history: chatMessages.slice(0, -1) });
    const result = await chat.sendMessage(userParts);
    const response = result.response.text();

    await saveChatHistory(farmerId, sessionId, 'user', messageText || '[media]', detectedLang, 'gemini-2.0-flash');
    await saveChatHistory(farmerId, sessionId, 'assistant', response, detectedLang, 'gemini-2.0-flash');

    return response;
  } catch (e) {
    console.error('AI response error:', e.message);
    return 'Sorry, I could not process your request right now. Please try again or type "help" for options.';
  }
}

// --- WHATSAPP SEND ---
const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
const accessToken = process.env.WA_ACCESS_TOKEN;

async function sendWhatsAppMessage(to, text) {
  if (!phoneNumberId || !accessToken) {
    console.log('WhatsApp not configured. Would send to', to, ':', text.substring(0, 100));
    return false;
  }
  try {
    const url = 'https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages';
    const resp = await axios.post(url, {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    }, {
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
    });
    console.log('WhatsApp message sent to', to, 'id:', resp.data?.messages?.[0]?.id);
    return true;
  } catch (e) {
    console.error('WhatsApp send error:', e.response?.data || e.message);
    return false;
  }
}

async function getMediaUrl(mediaId) {
  if (!accessToken) return null;
  try {
    const resp = await axios.get('https://graph.facebook.com/v21.0/' + mediaId, {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    return resp.data.url;
  } catch (e) {
    console.error('Get media URL error:', e.message);
    return null;
  }
}

// --- SEND MESSAGE API (for admin dashboard) ---
app.post('/api/v1/send-message', async (req, res) => {
  try {
    const { phone, message, farmer_id } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
    const sent = await sendWhatsAppMessage(phone, message);
    if (pool && farmer_id) {
      let session = await pool.query('SELECT * FROM wa_chat_sessions WHERE farmer_id=$1 AND status=$2', [farmer_id, 'active']);
      if (session.rows.length) {
        await pool.query(
          "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'admin', 'text', $3, $4, NOW())",
          [session.rows[0].id, farmer_id, message, sent ? 'sent' : 'failed']
        );
      }
    }
    res.json({ success: sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- HEALTH ---
app.get('/health', async (req, res) => {
  const dbOk = pool ? await pool.query('SELECT 1').then(() => true).catch(() => false) : false;
  res.json({
    status: 'healthy', service: 'whatsapp-gateway',
    timestamp: new Date().toISOString(),
    database: dbOk ? 'connected' : 'disconnected',
    ai: genAI ? 'gemini-ready' : 'not-configured',
    whatsapp: phoneNumberId ? 'configured' : 'not-configured'
  });
});

// --- WEBHOOK VERIFICATION ---
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

// --- WEBHOOK MESSAGE PROCESSING ---
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
          const profileName = contact.profile?.name || 'Unknown';
          const waMessageId = msg.id;
          const msgType = msg.type || 'text';
          const msgBody = msg.text?.body || msg.image?.caption || msg.audio?.caption || '';

          console.log('Incoming from ' + from + ' (' + profileName + ') [' + msgType + ']: ' + msgBody.substring(0, 100));

          if (!pool) { console.error('No database'); continue; }

          // 1. Find or create farmer
          let farmer = await pool.query('SELECT * FROM farmers WHERE phone = $1', [from]);
          if (farmer.rows.length === 0) {
            farmer = await pool.query(
              "INSERT INTO farmers (id, name, phone, language, status, onboarding_stage, profile_complete, total_interactions, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'hi', 'active', 'new', false, 1, NOW(), NOW()) RETURNING *",
              [profileName, from]
            );
            console.log('New farmer created:', from);
          } else {
            await pool.query('UPDATE farmers SET total_interactions = COALESCE(total_interactions, 0) + 1, last_interaction_at = NOW(), updated_at = NOW() WHERE phone = $1', [from]);
          }
          const farmerData = farmer.rows[0];
          const farmerId = farmerData.id;

          // 2. Find or create chat session
          let session = await pool.query('SELECT * FROM wa_chat_sessions WHERE farmer_id = $1 AND status = $2', [farmerId, 'active']);
          if (session.rows.length === 0) {
            session = await pool.query(
              "INSERT INTO wa_chat_sessions (id, farmer_id, status, last_message_at, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'active', NOW(), NOW(), NOW()) RETURNING *",
              [farmerId]
            );
          }
          const sessionId = session.rows[0].id;
          await pool.query('UPDATE wa_chat_sessions SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1', [sessionId]);

          // 3. Handle media - get download URL
          let mediaUrl = null;
          if (msgType === 'image' && msg.image?.id) {
            mediaUrl = await getMediaUrl(msg.image.id);
          } else if (msgType === 'audio' && msg.audio?.id) {
            mediaUrl = await getMediaUrl(msg.audio.id);
          } else if (msgType === 'voice' && msg.voice?.id) {
            mediaUrl = await getMediaUrl(msg.voice.id);
          }

          // 4. Store incoming message
          const storedMsgType = (msgType === 'voice') ? 'audio' : msgType;
          await pool.query(
            "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_message_id, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'inbound', 'farmer', $3, $4, $5, 'delivered', NOW())",
            [sessionId, farmerId, storedMsgType, msgBody || '[' + msgType + ']', waMessageId]
          );

          // 5. Coupon code detection (text messages only)
          if (msgType === 'text' && msgBody.trim()) {
            const couponMatch = msgBody.trim().match(/^[A-Z0-9]{6,20}$/i);
            if (couponMatch) {
              try {
                const adminApiUrl = process.env.ADMIN_API_URL || 'https://vartmap-admin-api.onrender.com';
                const validateResp = await axios.post(adminApiUrl + '/api/v1/coupons/validate', { code: couponMatch[0] });
                if (validateResp.data.valid) {
                  const redeemResp = await axios.post(adminApiUrl + '/api/v1/coupons/redeem-geo', { code: couponMatch[0], phone: from });
                  const rd = redeemResp.data;
                  let couponReply = rd.redeemed
                    ? 'Coupon ' + couponMatch[0].toUpperCase() + ' redeemed! You got ' + rd.discount_value + (rd.discount_type === 'percentage' ? '% discount' : ' off') + ' from ' + rd.campaign_name + '. Thank you!'
                    : 'Code ' + couponMatch[0].toUpperCase() + ' ' + (rd.error || 'could not be redeemed') + '.';
                  await sendWhatsAppMessage(from, couponReply);
                  await pool.query(
                    "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
                    [sessionId, farmerId, couponReply]
                  );
                  continue;
                }
              } catch (e) { console.log('Coupon check skipped:', e.message); }
            }
          }

          // 6. AI-POWERED RESPONSE
          const effectiveMsgType = (msgType === 'voice') ? 'audio' : msgType;
          const replyText = await getAIResponse(farmerId, sessionId, farmerData, msgBody, effectiveMsgType, mediaUrl);

          const sendResult = await sendWhatsAppMessage(from, replyText);

          // 7. Store outbound reply
          await pool.query(
            "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, $4, NOW())",
            [sessionId, farmerId, replyText, sendResult ? 'sent' : 'failed']
          );

          console.log('AI reply ' + (sendResult ? 'sent' : 'FAILED') + ' to ' + from);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

// --- STATUS ---
app.get('/api/v1/status', (req, res) => {
  res.json({ status: 'running', service: 'whatsapp-gateway', version: '2.0.0-ai', ai: genAI ? 'active' : 'inactive' });
});

app.listen(PORT, () => {
  console.log('WhatsApp Gateway v2.0 (AI) running on port ' + PORT);
  console.log('AI:', genAI ? 'Gemini ready' : 'NOT CONFIGURED - set GEMINI_API_KEY');
  console.log('WhatsApp:', phoneNumberId ? 'configured' : 'NOT CONFIGURED');
});
