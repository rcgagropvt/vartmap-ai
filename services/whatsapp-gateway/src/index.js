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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query('SELECT NOW()').then(() => console.log('Database connected')).catch(e => console.error('DB error:', e.message));

// --- REDIS (optional) ---
let redis = null;
try {
  if (process.env.REDIS_URL) {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: (t) => (t > 3 ? null : Math.min(t * 200, 2000)) });
    redis.on('connect', () => console.log('Redis connected'));
    redis.on('error', (e) => console.error('Redis error:', e.message));
  }
} catch (e) { console.log('Redis not available'); }

// --- AI SETUP (Gemini + Groq fallback) ---
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
let groqClient = null;
if (process.env.GROQ_API_KEY) {
  const Groq = require('groq-sdk');
  groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
}

// --- CACHES ---
let catalogCache = null;
let catalogCacheTime = 0;
let botConfigCache = null;
let botConfigCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

const ADMIN_API_URL = process.env.ADMIN_API_URL || 'https://vartmap-admin-api.onrender.com';

// --- FETCH PRODUCT CATALOG ---
async function getProductCatalog() {
  if (catalogCache && (Date.now() - catalogCacheTime < CACHE_TTL)) return catalogCache;
  try {
    const resp = await axios.get(ADMIN_API_URL + '/api/v1/catalog/ai-context');
    catalogCache = resp.data;
    catalogCacheTime = Date.now();
    return catalogCache;
  } catch (e) {
    console.error('Failed to fetch catalog:', e.message);
    return catalogCache || { brand: 'Vartmaan Fertilizers', company: 'RCG Agro Pvt Ltd', products: [], recommendations: [] };
  }
}

// --- FETCH BOT CONFIG (welcome, menu, flows, knowledge) ---
async function getBotConfig() {
  if (botConfigCache && (Date.now() - botConfigCacheTime < CACHE_TTL)) return botConfigCache;
  try {
    const token = process.env.ADMIN_API_TOKEN || '';
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};

    const [configResp, menuResp, flowsResp, knowledgeResp] = await Promise.allSettled([
      axios.get(ADMIN_API_URL + '/api/v1/public/bot/config'),
      axios.get(ADMIN_API_URL + '/api/v1/public/bot/menu'),
      axios.get(ADMIN_API_URL + '/api/v1/public/bot/flows'),
      axios.get(ADMIN_API_URL + '/api/v1/public/knowledge')
    ]);

    const configRows = configResp.status === 'fulfilled' ? (configResp.value.data.config || []) : [];
    const configMap = {};
    for (const row of configRows) {
      try { configMap[row.config_key] = JSON.parse(row.config_value); } catch { configMap[row.config_key] = row.config_value; }
    }

    botConfigCache = {
      welcome_hi: configMap.welcome_message_hi || 'Namaste! Main VartMap Krishi Sahayak hoon. Aapki kaise madad kar sakta hoon?',
      welcome_en: configMap.welcome_message_en || 'Hello! I am VartMap Krishi Sahayak. How can I help you?',
      onboarding_enabled: configMap.onboarding_enabled !== undefined ? configMap.onboarding_enabled : true,
      onboarding_fields: configMap.onboarding_fields || ['name', 'crops'],
      menu_items: menuResp.status === 'fulfilled' ? (menuResp.value.data.items || []) : [],
      flows: flowsResp.status === 'fulfilled' ? (flowsResp.value.data.flows || []) : [],
      knowledge: knowledgeResp.status === 'fulfilled' ? (knowledgeResp.value.data.documents || knowledgeResp.value.data.items || []) : []
    };
    botConfigCacheTime = Date.now();
    console.log('Bot config loaded: ' + botConfigCache.menu_items.length + ' menu items, ' + botConfigCache.flows.length + ' flows, ' + botConfigCache.knowledge.length + ' knowledge docs');
    return botConfigCache;
  } catch (e) {
    console.error('Failed to fetch bot config:', e.message);
    return botConfigCache || {
      welcome_hi: 'Namaste! Main VartMap Krishi Sahayak hoon.',
      welcome_en: 'Hello! I am VartMap Krishi Sahayak.',
      onboarding_enabled: false,
      onboarding_fields: [],
      menu_items: [],
      flows: [],
      knowledge: []
    };
  }
}

// --- BUILD SYSTEM PROMPT (now includes knowledge base) ---
function buildSystemPrompt(catalog, farmer, language, botConfig) {
    const productList = (catalog.products || []).map(p =>
    '- ' + p.product_name + ' (' + (p.product_code || '') + '): ' + (p.composition || '') + '. Crops: ' + (p.target_crops || []).join(', ') + '. ' + (p.benefits || '') + ' Dosage: ' + (p.dosage_per_acre || 'as per soil test') + (p.image_url ? ' [IMAGE:' + p.product_code + ']' : '')
  ).join('\n');
  const recoList = (catalog.recommendations || []).map(r =>
    '- ' + r.crop_name + ' / ' + r.growth_stage + ' (' + (r.days_range || '') + '): Use ' + r.product_name + ' - ' + r.dosage + '. Method: ' + (r.application_method || 'soil application')
  ).join('\n');
  const langInstruction = language === 'hi'
    ? 'Respond in Hindi (Devanagari script). If the farmer writes in English, still reply in Hindi unless they explicitly ask for English.'
    : 'Detect the language the farmer is using and respond in the same language. If mixed Hindi-English (Hinglish), respond in Hindi.';

  // Knowledge base injection
  let knowledgeSection = '';
  if (botConfig && botConfig.knowledge && botConfig.knowledge.length > 0) {
    const knowledgeDocs = botConfig.knowledge
      .filter(d => d.is_active !== false)
      .map(d => '- [' + (d.title || d.name || 'Document') + ']: ' + (d.content_text || d.content || d.description || '').substring(0, 2000))
      .join('\n');
    if (knowledgeDocs) {
      knowledgeSection = '\n\nCOMPANY KNOWLEDGE BASE (use this information to answer questions about Vartmaan Fertilizers, its brand, vision, mission, values, products, and philosophy):\n' + knowledgeDocs;
    }
  }

  // Menu items for context
  let menuSection = '';
  if (botConfig && botConfig.menu_items && botConfig.menu_items.length > 0) {
    const menuList = botConfig.menu_items
      .filter(m => m.is_active !== false)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
      .map(m => '- "' + (m.menu_key || '') + '": ' + (m.title_hi || m.title_en || ''))
      .join('\n');
    if (menuList) {
      menuSection = '\n\nAVAILABLE MENU OPTIONS (farmers can select these):\n' + menuList + '\nWhen a farmer selects one of these options, provide relevant help on that topic.';
    }
  }

    return 'You are "VartMap Krishi Sahayak" - an AI agricultural assistant for Indian farmers, EXCLUSIVELY representing Vartmaan Fertilizers (RCG Agro Private Limited).\n\n' +
    'STRICT RULES (NEVER VIOLATE):\n' +
    '1. You discuss topics related to: agriculture, farming, crops, soil, fertilizers, pesticides, irrigation, weather for farming, government agricultural schemes, mandi/market prices for crops, Vartmaan Fertilizers products, AND anything about Vartmaan Fertilizers as a company (vision, mission, values, brand story, contact info, etc.).\n' +
    '2. If a farmer asks about topics completely unrelated to agriculture or Vartmaan (movies, cricket, politics, entertainment, personal advice, etc.), politely redirect: "Main kheti-kisaani aur Vartmaan Fertilizers se jude sawaalon mein madad kar sakta hoon. Kripya apni fasal ya hamare products se juda koi sawal poochein."\n' +
    '3. NEVER mention, discuss, compare, or recommend ANY competitor brand or product by name. Competitors include but are not limited to: Tata Rallis, UPL, Bayer, Syngenta, IFFCO, Coromandel, Zuari, Chambal, Rashtriya Chemicals, Deepak Fertilizers, Godrej Agrovet, PI Industries, Dhanuka, Crystal Crop, and any other brand.\n' +
    '4. If asked about competitor products, say: "Main sirf Vartmaan Fertilizers ke products ke baare mein jaankari de sakta hoon. Hamare products aapki fasal ke liye sabse behtareen hain."\n' +
    '5. You ONLY recommend Vartmaan Fertilizers products from the catalog below. Never invent or suggest products not in the catalog.\n\n' +
    'ROLE:\n' +
    '- You are a helpful, knowledgeable agricultural advisor who speaks like a friendly local expert\n' +
    '- You recommend Vartmaan Fertilizers products when relevant to the farmer\'s problem\n' +
    '- You help with crop advice, soil health, pest/disease identification, weather guidance, government schemes, and mandi prices\n' +
    '- Keep responses concise (under 300 words) since this is WhatsApp\n' +
    '- Use simple language that farmers understand\n\n' +
    'LANGUAGE:\n' + langInstruction + '\n\n' +
    'FARMER CONTEXT:\n' +
    '- Name: ' + (farmer.name || 'Kisan') + '\n' +
    '- Phone: ' + (farmer.phone || 'unknown') + '\n' +
    '- Village: ' + (farmer.village || 'unknown') + '\n' +
    '- State: ' + (farmer.state_name || 'unknown') + '\n' +
    '- Crops: ' + (farmer.crops || 'unknown') + '\n' +
    '- Soil Type: ' + (farmer.soil_type || 'unknown') + '\n\n' +
    'VARTMAAN FERTILIZERS PRODUCT CATALOG (ONLY recommend these):\n' + (productList || 'No products loaded') + '\n\n' +
    'CROP-SPECIFIC RECOMMENDATIONS:\n' + (recoList || 'No specific recommendations loaded') + '\n' +
    knowledgeSection + menuSection + '\n\n' +
    'PRODUCT RECOMMENDATION GUIDELINES:\n' +
    '1. For zinc deficiency: recommend VARTIZIN products\n' +
    '2. For iron deficiency/chlorosis: recommend VARTIFER products\n' +
    '3. For sugarcane: recommend VARTIMIX Ganna Special 10%\n' +
    '4. For general micronutrient needs: recommend VARTIMIX Multi-Crop 6% or Balshali 4%\n' +
    '5. For premium/alkaline soil needs: recommend Kavach (chelated) variants\n' +
    '6. If you do not know something, say so honestly - do not make up information\n' +
    '7. For pest/disease images, describe what you see and suggest treatment using Vartmaan products\n' +
    '8. Always be respectful and address the farmer warmly\n' +
    '9. If asked about prices, say "Kripya apne nazdeeki dealer se sampark karein ya humari helpline par call karein"\n' +
    '10. When recommending a product that has [IMAGE:code] tag, include exactly this on a new line: [SEND_IMAGE:product_code]\n' +
    '11. For emergency pest attacks, advise contacting local Krishi Vigyan Kendra (KVK)\n' +
    '12. If farmer sends greeting (hi, hello, namaste), respond warmly and ask how you can help with their farming needs';
}

// --- CHAT HISTORY ---
async function getChatHistory(farmerId, limit) {
  if (!pool) return [];
  try {
    const r = await pool.query('SELECT role, content FROM ai_chat_history WHERE farmer_id=$1 ORDER BY created_at DESC LIMIT $2', [farmerId, limit || 10]);
    return r.rows.reverse();
  } catch (e) { return []; }
}

async function saveChatHistory(farmerId, sessionId, role, content, lang, model) {
  if (!pool) return;
  try {
    await pool.query('INSERT INTO ai_chat_history (id, farmer_id, session_id, role, content, language, model, created_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())', [farmerId, sessionId, role, content, lang || 'hi', model || 'gemini']);
  } catch (e) { console.error('Save chat history error:', e.message); }
}

// --- GROQ RESPONSE ---
async function getGroqResponse(systemPrompt, history, messageText) {
  if (!groqClient) return null;
  try {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const h of history) {
      messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
    }
    messages.push({ role: 'user', content: messageText });
    const completion = await groqClient.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      max_tokens: 1024,
      temperature: 0.7
    });
    return completion.choices[0]?.message?.content || null;
  } catch (e) {
    console.error('Groq error:', e.message);
    return null;
  }
}

// --- GEMINI RESPONSE ---
async function getGeminiResponse(systemPrompt, history, userParts, modelName) {
  if (!genAI) return null;
  try {
    const model = genAI.getGenerativeModel({ model: modelName || 'gemini-2.5-flash-lite' });
    const chatMessages = [];
    chatMessages.push({ role: 'user', parts: [{ text: 'System instructions: ' + systemPrompt }] });
    chatMessages.push({ role: 'model', parts: [{ text: 'Understood. I am VartMap Krishi Sahayak, ready to help farmers.' }] });
    for (const h of history) {
      chatMessages.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] });
    }
    chatMessages.push({ role: 'user', parts: userParts });
    const chat = model.startChat({ history: chatMessages.slice(0, -1) });
    const result = await chat.sendMessage(userParts);
    return result.response.text();
  } catch (e) {
    console.error('Gemini (' + (modelName || 'gemini-2.5-flash-lite') + ') error:', e.message);
    return null;
  }
}

// --- AI RESPONSE (with Bot Config integration) ---
async function getAIResponse(farmerId, sessionId, farmer, messageText, messageType, mediaUrl) {
  if (!genAI && !groqClient) {
    return 'AI service is not configured. Our team will respond shortly.';
  }
  try {
    const [catalog, botConfig] = await Promise.all([getProductCatalog(), getBotConfig()]);
    const detectedLang = /[\u0900-\u097F]/.test(messageText) ? 'hi' : 'en';
    const systemPrompt = buildSystemPrompt(catalog, farmer, detectedLang, botConfig);
    const history = await getChatHistory(farmerId, 8);
    let response = null;
    let modelUsed = 'unknown';

    // For image/voice: must use Gemini (multimodal)
    if ((messageType === 'image' || messageType === 'audio') && mediaUrl) {
      let userParts = [];
      try {
        const mediaResp = await axios.get(mediaUrl, {
          headers: { 'Authorization': 'Bearer ' + process.env.WA_ACCESS_TOKEN },
          responseType: 'arraybuffer'
        });
        const base64 = Buffer.from(mediaResp.data).toString('base64');
        const mimeType = mediaResp.headers['content-type'] || (messageType === 'image' ? 'image/jpeg' : 'audio/ogg');
        userParts.push({ inlineData: { data: base64, mimeType: mimeType } });
        if (messageType === 'image') {
          userParts.push({ text: messageText || 'Please analyze this crop/plant image. Identify any disease, pest damage, or nutrient deficiency. Recommend treatment using Vartmaan Fertilizers products if applicable.' });
        } else {
          userParts.push({ text: 'The farmer sent a voice message. Listen to it, understand their question (may be in Hindi or another Indian language), and respond helpfully in the same language.' });
        }
      } catch (mediaErr) {
        console.error('Media download error:', mediaErr.message);
        userParts = [{ text: messageText || 'The farmer sent media but it could not be loaded. Ask them to describe the problem in text.' }];
      }
      response = await getGeminiResponse(systemPrompt, history, userParts, 'gemini-2.5-flash-lite');
      modelUsed = 'gemini-2.5-flash-lite';
      if (!response) {
        response = await getGeminiResponse(systemPrompt, history, userParts, 'gemini-2.0-flash');
        modelUsed = 'gemini-2.0-flash';
      }
      if (!response) {
        response = await getGeminiResponse(systemPrompt, history, userParts, 'gemini-2.5-flash');
        modelUsed = 'gemini-2.5-flash';
      }
    } else {
      // Text messages: try Gemini first, then Groq fallback
      const userParts = [{ text: messageText }];
      response = await getGeminiResponse(systemPrompt, history, userParts, 'gemini-2.5-flash-lite');
      modelUsed = 'gemini-2.5-flash-lite';
      if (!response) {
        response = await getGeminiResponse(systemPrompt, history, userParts, 'gemini-2.0-flash');
        modelUsed = 'gemini-2.0-flash';
      }
      if (!response) {
        console.log('Gemini exhausted, trying Groq...');
        response = await getGroqResponse(systemPrompt, history, messageText);
        modelUsed = 'groq-llama-3.3-70b';
      }
    }

    if (!response) {
      return 'Maaf kijiye, abhi humara AI system busy hai. Kripya thodi der baad dobara try karein ya "menu" type karein.';
    }

    await saveChatHistory(farmerId, sessionId, 'user', messageText || '[media]', detectedLang, modelUsed);
    await saveChatHistory(farmerId, sessionId, 'assistant', response, detectedLang, modelUsed);
    console.log('AI response via ' + modelUsed + ' (' + response.length + ' chars)');
    return response;
  } catch (e) {
    console.error('AI response error:', e.message);
    return 'Sorry, I could not process your request right now. Please try again or type "menu" for options.';
  }
}

// --- WHATSAPP SEND ---
const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
const accessToken = process.env.WA_ACCESS_TOKEN;

async function sendWhatsAppMessage(to, text) {
  try {
    const resp = await axios.post(
      'https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages',
      { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: text } },
      { headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' } }
    );
    console.log('Message sent to ' + to + ', id: ' + resp.data.messages?.[0]?.id);
    return true;
  } catch (e) {
    console.error('Send message error:', e.response?.data || e.message);
    return false;
  }
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  if (!phoneNumberId || !accessToken) return false;
  try {
    const resp = await axios.post(
      'https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages',
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'image',
        image: { link: imageUrl, caption: caption || '' }
      },
      { headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' } }
    );
    console.log('Image sent to ' + to);
    return true;
  } catch (e) {
    console.error('Send image error:', e.response?.data || e.message);
    return false;
  }
}


// Send WhatsApp interactive buttons
async function sendWhatsAppButtons(to, bodyText, buttons) {
  try {
    const buttonPayload = buttons.slice(0, 3).map((btn, idx) => ({
      type: 'reply',
      reply: { id: btn.id || ('btn_' + idx), title: (btn.title || '').substring(0, 20) }
    }));
    const resp = await axios.post(
      'https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages',
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: { buttons: buttonPayload }
        }
      },
      { headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' } }
    );
    console.log('Buttons sent to ' + to);
    return true;
  } catch (e) {
    console.error('Send buttons error:', e.response?.data || e.message);
    // Fallback to plain text
    return sendWhatsAppMessage(to, bodyText);
  }
}

// Send WhatsApp interactive list
async function sendWhatsAppList(to, bodyText, buttonLabel, sections) {
  try {
    const resp = await axios.post(
      'https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages',
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: (buttonLabel || 'Menu').substring(0, 20),
            sections: sections
          }
        }
      },
      { headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' } }
    );
    console.log('List sent to ' + to);
    return true;
  } catch (e) {
    console.error('Send list error:', e.response?.data || e.message);
    return sendWhatsAppMessage(to, bodyText);
  }
}

// --- BUILD MENU MESSAGE ---
async function sendMenuMessage(to, botConfig, language) {
  const items = (botConfig.menu_items || [])
    .filter(m => m.is_active !== false)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  if (items.length === 0) {
    return; // No menu configured, AI will handle freely
  }

  if (items.length <= 3) {
    // Use buttons for 1-3 items
    const buttons = items.map(m => ({
      id: m.menu_key || m.id,
      title: (language === 'hi' ? (m.title_hi || m.title_en) : (m.title_en || m.title_hi)).substring(0, 20)
    }));
    const bodyText = language === 'hi'
      ? 'Aap neeche diye gaye options mein se choose kar sakte hain:'
      : 'You can choose from the options below:';
    await sendWhatsAppButtons(to, bodyText, buttons);
  } else {
    // Use list for 4+ items
    const rows = items.map(m => ({
      id: m.menu_key || m.id,
      title: (language === 'hi' ? (m.title_hi || m.title_en) : (m.title_en || m.title_hi)).substring(0, 24),
      description: (language === 'hi' ? (m.description_hi || m.description_en || '') : (m.description_en || m.description_hi || '')).substring(0, 72)
    }));
    const bodyText = language === 'hi'
      ? 'Aap neeche diye gaye options mein se choose kar sakte hain:'
      : 'You can choose from the options below:';
    await sendWhatsAppList(to, bodyText, 'Options', [{ title: 'Services', rows: rows }]);
  }
}

// --- ONBOARDING HANDLER ---
async function handleOnboarding(farmerId, farmerData, from, msgBody, sessionId, botConfig) {
  const stage = farmerData.onboarding_stage || 'new';
  const lang = farmerData.language || 'hi';

  if (stage === 'new') {
    // First message ever - send welcome and ask name
    const welcome = lang === 'hi' ? botConfig.welcome_hi : botConfig.welcome_en;
    await sendWhatsAppMessage(from, welcome);

    if (botConfig.onboarding_enabled && botConfig.onboarding_fields.includes('name')) {
      const askName = lang === 'hi'
        ? 'Sabse pehle, aapka naam bataiye?'
        : 'First, what is your name?';
      await sendWhatsAppMessage(from, askName);
      await pool.query("UPDATE farmers SET onboarding_stage = 'awaiting_name', updated_at = NOW() WHERE id = $1", [farmerId]);

      await pool.query(
        "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
        [sessionId, farmerId, welcome + '\n' + askName]
      );
      return true; // handled
    } else {
      // No onboarding, go straight to menu
      await pool.query("UPDATE farmers SET onboarding_stage = 'complete', profile_complete = true, updated_at = NOW() WHERE id = $1", [farmerId]);
      await sendMenuMessage(from, botConfig, lang);
      return true;
    }
  }

  if (stage === 'awaiting_name') {
    const name = msgBody.trim();
    if (name.length < 2 || name.length > 60) {
      const retry = lang === 'hi' ? 'Kripya apna sahi naam batayein:' : 'Please tell me your correct name:';
      await sendWhatsAppMessage(from, retry);
      return true;
    }
    await pool.query("UPDATE farmers SET name = $1, onboarding_stage = $2, updated_at = NOW() WHERE id = $3",
      [name, botConfig.onboarding_fields.includes('crops') ? 'awaiting_crops' : 'complete', farmerId]);

    if (botConfig.onboarding_fields.includes('crops')) {
      const askCrops = lang === 'hi'
        ? 'Dhanyavaad ' + name + '! Aap kaun si phasalein ugaate hain? (jaise: gehun, dhan, ganna)'
        : 'Thank you ' + name + '! What crops do you grow? (e.g., wheat, rice, sugarcane)';
      await sendWhatsAppMessage(from, askCrops);
      await pool.query(
        "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
        [sessionId, farmerId, askCrops]
      );
    } else {
      await pool.query("UPDATE farmers SET profile_complete = true WHERE id = $1", [farmerId]);
      const done = lang === 'hi'
        ? 'Dhanyavaad ' + name + '! Aap ab mujhse kuch bhi pooch sakte hain.'
        : 'Thank you ' + name + '! You can now ask me anything.';
      await sendWhatsAppMessage(from, done);
      await sendMenuMessage(from, botConfig, lang);
    }
    return true;
  }

  if (stage === 'awaiting_crops') {
    const crops = msgBody.trim();
    const farmerName = farmerData.name || 'Kisan';
        await pool.query("UPDATE farmers SET crops = $1, onboarding_stage = 'complete', profile_complete = true, updated_at = NOW() WHERE id = $2",
      ['{' + crops.split(/[,\s]+/).map(c => c.trim()).filter(c => c).join(',') + '}', farmerId]);


    const done = (farmerData.language || 'hi') === 'hi'
      ? 'Bahut badhiya ' + farmerName + '! Aapki profile complete ho gayi. Ab main aapki har tarah se madad kar sakta hoon.'
      : 'Excellent ' + farmerName + '! Your profile is complete. I can now help you with everything.';
    await sendWhatsAppMessage(from, done);
    await sendMenuMessage(from, botConfig, farmerData.language || 'hi');
    await pool.query(
      "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
      [sessionId, farmerId, done]
    );
    return true;
  }

  return false; // Not in onboarding, continue normal flow
}

// --- FLOW ENGINE ---
async function handleFlow(farmerId, farmerData, from, msgBody, sessionId, botConfig) {
  const lang = farmerData.language || 'hi';
  const lowerMsg = (msgBody || '').toLowerCase().trim();

  // Check if message matches a menu key
  const menuItems = (botConfig.menu_items || []).filter(m => m.is_active !== false);
  let matchedMenu = null;

  // Check interactive button/list reply IDs
  for (const item of menuItems) {
    const key = (item.menu_key || '').toLowerCase();
    if (key && (lowerMsg === key || lowerMsg.includes(key))) {
      matchedMenu = item;
      break;
    }
  }

  // Also check by title match
  if (!matchedMenu) {
    for (const item of menuItems) {
      const titleHi = (item.title_hi || '').toLowerCase();
      const titleEn = (item.title_en || '').toLowerCase();
      if ((titleHi && lowerMsg.includes(titleHi)) || (titleEn && lowerMsg.includes(titleEn))) {
        matchedMenu = item;
        break;
      }
    }
  }

  if (!matchedMenu) return false;

  console.log('Menu matched: ' + matchedMenu.menu_key + ' for farmer ' + farmerId);

  // Check if this menu item has a linked flow
  const linkedFlow = (botConfig.flows || []).find(f =>
    f.menu_key === matchedMenu.menu_key || f.trigger_key === matchedMenu.menu_key
  );

  if (linkedFlow && linkedFlow.steps && linkedFlow.steps.length > 0) {
    // Execute flow steps
    const steps = linkedFlow.steps.sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
    for (const step of steps) {
      if (step.step_type === 'text') {
        const text = lang === 'hi' ? (step.content_hi || step.content_en || step.content || '') : (step.content_en || step.content_hi || step.content || '');
        if (text) await sendWhatsAppMessage(from, text);
      } else if (step.step_type === 'ai_query') {
        // Let AI handle with a specific prompt context
        return false; // Fall through to AI with the message
      } else if (step.step_type === 'buttons') {
        try {
          const btns = typeof step.options === 'string' ? JSON.parse(step.options) : (step.options || []);
          if (btns.length > 0) {
            const text = lang === 'hi' ? (step.content_hi || step.content || '') : (step.content_en || step.content || '');
            await sendWhatsAppButtons(from, text || 'Choose an option:', btns.slice(0, 3).map(b => ({ id: b.id || b.key, title: (b.title || b.label || '').substring(0, 20) })));
          }
        } catch (e) { console.error('Flow button parse error:', e.message); }
      }
    }
    return true; // Flow handled the message
  }

  // Menu item matched but no flow — just acknowledge and let AI handle the topic
  const ack = lang === 'hi'
    ? (matchedMenu.title_hi || matchedMenu.title_en || 'Option') + ' ke baare mein jaankari de raha hoon...'
    : 'Let me help you with ' + (matchedMenu.title_en || matchedMenu.title_hi || 'that') + '...';
  // Don't send ack, let AI give a proper response
  return false;
}

// --- MEDIA URL ---
async function getMediaUrl(mediaId) {
  try {
    const resp = await axios.get('https://graph.facebook.com/v21.0/' + mediaId, {
      headers: { 'Authorization': 'Bearer ' + process.env.WA_ACCESS_TOKEN }
    });
    return resp.data.url;
  } catch (e) {
    console.error('Get media URL error:', e.message);
    return null;
  }
}

// --- HEALTH ---
app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW()');
    const botCfg = await getBotConfig();
    res.json({
      status: 'healthy',
      service: 'whatsapp-gateway',
      version: '3.0.0-bot-builder',
      timestamp: r.rows[0].now,
      database: 'connected',
      ai: genAI ? 'gemini-ready' : 'not-configured',
      groq: groqClient ? 'ready' : 'not-configured',
      bot: {
        menu_items: (botCfg.menu_items || []).length,
        flows: (botCfg.flows || []).length,
        knowledge_docs: (botCfg.knowledge || []).length,
        onboarding: botCfg.onboarding_enabled ? 'enabled' : 'disabled'
      }
    });
  } catch (e) { res.status(500).json({ status: 'unhealthy', error: e.message }); }
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

    const botConfig = await getBotConfig();

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
          // Deduplicate - skip if we already processed this message
          if (waMessageId) {
            try {
              const dup = await pool.query('SELECT id FROM wa_messages WHERE wa_message_id = $1', [waMessageId]);
              if (dup.rows.length > 0) {
                console.log('Duplicate message skipped:', waMessageId);
                continue;
              }
            } catch (e) { /* ignore dedup errors, proceed */ }
          }

          const msgType = msg.type || 'text';

          // Handle interactive replies (button clicks, list selections)
          let msgBody = '';
          if (msg.type === 'interactive') {
            if (msg.interactive?.type === 'button_reply') {
              msgBody = msg.interactive.button_reply.id || msg.interactive.button_reply.title || '';
            } else if (msg.interactive?.type === 'list_reply') {
              msgBody = msg.interactive.list_reply.id || msg.interactive.list_reply.title || '';
            }
          } else {
            msgBody = msg.text?.body || msg.image?.caption || msg.audio?.caption || '';
          }

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
          const storedMsgType = (msgType === 'voice') ? 'audio' : (msgType === 'interactive' ? 'text' : msgType);
          await pool.query(
            "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_message_id, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'inbound', 'farmer', $3, $4, $5, 'delivered', NOW())",
            [sessionId, farmerId, storedMsgType, msgBody || '[' + msgType + ']', waMessageId]
          );

          // 5. ONBOARDING CHECK (new farmers)
          const onboardingStage = farmerData.onboarding_stage || 'new';
          if (onboardingStage !== 'complete' && botConfig.onboarding_enabled) {
            const handled = await handleOnboarding(farmerId, farmerData, from, msgBody, sessionId, botConfig);
            if (handled) continue;
          }

          // 6. MENU / HELP trigger
          const lowerMsg = (msgBody || '').toLowerCase().trim();
          if (lowerMsg === 'menu' || lowerMsg === 'help' || lowerMsg === 'options' || lowerMsg === 'start') {
            await sendMenuMessage(from, botConfig, farmerData.language || 'hi');
            await pool.query(
              "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
              [sessionId, farmerId, '[menu sent]']
            );
            continue;
          }

          // 7. FLOW ENGINE (check if message matches a menu item / flow)
          const flowHandled = await handleFlow(farmerId, farmerData, from, msgBody, sessionId, botConfig);
          if (flowHandled) {
            await pool.query(
              "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
              [sessionId, farmerId, '[flow: ' + lowerMsg + ']']
            );
            continue;
          }

          // 8. Coupon code detection (text messages only)
          if ((msgType === 'text' || msgType === 'interactive') && msgBody.trim()) {
            const couponMatch = msgBody.trim().match(/^[A-Z0-9]{6,20}$/i);
            if (couponMatch) {
              try {
                const validateResp = await axios.post(ADMIN_API_URL + '/api/v1/coupons/validate', { code: couponMatch[0] });
                if (validateResp.data.valid) {
                  const redeemResp = await axios.post(ADMIN_API_URL + '/api/v1/coupons/redeem-geo', { code: couponMatch[0], phone: from });
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

          // 9. AI-POWERED RESPONSE
          const effectiveMsgType = (msgType === 'voice') ? 'audio' : (msgType === 'interactive' ? 'text' : msgType);
          const replyText = await getAIResponse(farmerId, sessionId, farmerData, msgBody, effectiveMsgType, mediaUrl);

                    // Check if AI response contains image tags
          let cleanReply = replyText;
          const imageMatches = replyText.match(/\[SEND_IMAGE:([^\]]+)\]/g);
          if (imageMatches) {
            cleanReply = replyText.replace(/\[SEND_IMAGE:[^\]]+\]/g, '').trim();
            const catalog = await getProductCatalog();
            for (const tag of imageMatches) {
              const code = tag.replace('[SEND_IMAGE:', '').replace(']', '').trim();
              const product = (catalog.products || []).find(p => p.product_code === code || p.product_name.toLowerCase().includes(code.toLowerCase()));
              if (product && product.image_url && product.image_url.startsWith('http')) {
                await sendWhatsAppImage(from, product.image_url, product.product_name + ' - ' + (product.composition || ''));
              }
            }
          }
          const sendResult = await sendWhatsAppMessage(from, cleanReply);


          // 10. Store outbound reply
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
  res.json({ status: 'running', service: 'whatsapp-gateway', version: '3.0.0-bot-builder', ai: genAI ? 'active' : 'inactive', groq: groqClient ? 'active' : 'inactive' });
});

app.listen(PORT, () => {
  console.log('WhatsApp Gateway v3.0 (Bot Builder) running on port ' + PORT);
  console.log('AI:', genAI ? 'Gemini ready' : 'NOT CONFIGURED');
  console.log('Groq:', groqClient ? 'ready' : 'NOT CONFIGURED');
  console.log('WhatsApp:', phoneNumberId ? 'configured' : 'NOT CONFIGURED');
});