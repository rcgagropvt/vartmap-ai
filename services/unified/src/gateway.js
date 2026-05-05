// VartMap WhatsApp Gateway Routes Module
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = function setupGateway(app, pool, redis) {
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

// --- AI CHAT MODE TRACKER ---
// Tracks which farmers are in AI chat mode { farmerId: { active: true, startedAt: timestamp } }
const aiChatModes = {};
const AI_CHAT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// --- PENDING ACTION TRACKER ---
// --- PENDING ACTION TRACKER ---
const pendingActions = {};
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;

function setPendingAction(farmerId, action) {
  pendingActions[farmerId] = { action, timestamp: Date.now() };
}
function getPendingAction(farmerId) {
  const pending = pendingActions[farmerId];
  if (!pending) return null;
  if (Date.now() - pending.timestamp > PENDING_TIMEOUT_MS) {
    delete pendingActions[farmerId];
    return null;
  }
  return pending.action;
}
function setPendingAction(farmerId, action, extra) {
  pendingActions[farmerId] = { action, timestamp: Date.now(), ...(extra || {}) };
}
function getPendingAction(farmerId) {
  const pending = pendingActions[farmerId];
  if (!pending) return null;
  if (Date.now() - pending.timestamp > PENDING_TIMEOUT_MS) {
    delete pendingActions[farmerId];
    return null;
  }
  return pending.action;
}
function getPendingData(farmerId) {
  return pendingActions[farmerId] || {};
}
function clearPendingAction(farmerId) {
  delete pendingActions[farmerId];
}


// --- HINDI TO ENGLISH CROP MAPPING ---
const cropMapping = {
  'gehun': 'Wheat', 'gehu': 'Wheat', 'gandum': 'Wheat', 'wheat': 'Wheat',
  'chawal': 'Paddy(Common)', 'dhan': 'Paddy(Common)', 'dhaan': 'Paddy(Common)', 'rice': 'Paddy(Common)', 'paddy': 'Paddy(Common)',
  'makka': 'Maize', 'makai': 'Maize', 'maize': 'Maize', 'corn': 'Maize',
  'urad': 'Black Gram(Urd Beans)(Whole)', 'urd': 'Black Gram(Urd Beans)(Whole)',
  'matar': 'Green Peas', 'peas': 'Green Peas', 'hari matar': 'Green Peas',
  'guar': 'Guar', 'cluster beans': 'Cluster beans',
  'sarson': 'Mustard', 'sarso': 'Mustard', 'mustard': 'Mustard', 'rai': 'Mustard',
  'kapas': 'Cotton', 'cotton': 'Cotton', 'rui': 'Cotton',
  'tamatar': 'Tomato', 'tomato': 'Tomato',
  'baingan': 'Brinjal', 'brinjal': 'Brinjal',
  'patta gobhi': 'Cabbage', 'cabbage': 'Cabbage', 'band gobhi': 'Cabbage',
  'phool gobhi': 'Cauliflower', 'cauliflower': 'Cauliflower', 'gobhi': 'Cauliflower',
  'lauki': 'Bottle gourd', 'bottle gourd': 'Bottle gourd', 'ghiya': 'Bottle gourd',
  'parwal': 'Pointed gourd(Parval)', 'parval': 'Pointed gourd(Parval)',
  'tori': 'Ridgeguard(Tori)', 'torai': 'Ridgeguard(Tori)',
  'hari mirch': 'Green Chilli', 'mirchi': 'Green Chilli', 'green chilli': 'Green Chilli',
  'methi': 'Methi(Leaves)', 'fenugreek': 'Methi(Leaves)',
  'nimbu': 'Lemon', 'lemon': 'Lemon', 'neembu': 'Lemon',
  'chukandar': 'Beetroot', 'beetroot': 'Beetroot',
  'papita': 'Papaya', 'papaya': 'Papaya',
  'mosambi': 'Mousambi(Sweet Lime)', 'mousambi': 'Mousambi(Sweet Lime)', 'sweet lime': 'Mousambi(Sweet Lime)',
  'seb': 'Apple', 'apple': 'Apple',
  'chana': 'Gram', 'gram': 'Gram',
};
function translateCrop(input) {
  const lower = (input || '').toLowerCase().trim();
  return cropMapping[lower] || input;
}

// --- QUICK SELECT OPTIONS ---
const popularCrops = [
  { id: 'crop_wheat', title: 'Gehun (Wheat)' },
  { id: 'crop_paddy', title: 'Dhan (Paddy)' },
  { id: 'crop_mustard', title: 'Sarson (Mustard)' },
  { id: 'crop_maize', title: 'Makka (Maize)' },
  { id: 'crop_tomato', title: 'Tamatar (Tomato)' },
  { id: 'crop_cotton', title: 'Kapas (Cotton)' },
  { id: 'crop_cauliflower', title: 'Gobhi (Cauliflower)' },
  { id: 'crop_greenpeas', title: 'Matar (Green Peas)' },
  { id: 'crop_brinjal', title: 'Baingan (Brinjal)' },
  { id: 'crop_greenchilli', title: 'Hari Mirch (Chilli)' }
];
const cropIdMapping = {
  'crop_wheat': 'Wheat', 'crop_paddy': 'Paddy(Common)', 'crop_mustard': 'Mustard',
  'crop_maize': 'Maize', 'crop_tomato': 'Tomato', 'crop_cotton': 'Cotton',
  'crop_cauliflower': 'Cauliflower', 'crop_greenpeas': 'Green Peas',
  'crop_brinjal': 'Brinjal', 'crop_greenchilli': 'Green Chilli'
};

const popularDistricts = [
  { id: 'dist_agra', title: 'Agra' },
  { id: 'dist_indore', title: 'Indore' },
  { id: 'dist_lucknow', title: 'Lucknow' },
  { id: 'dist_prayagraj', title: 'Prayagraj' },
  { id: 'dist_varanasi', title: 'Varanasi' }
];
const districtIdMapping = {
  'dist_agra': 'Agra', 'dist_indore': 'Indore', 'dist_lucknow': 'Lucknow',
  'dist_prayagraj': 'Prayagraj', 'dist_varanasi': 'Varanasi'
};

function translateCrop(input) {
  const lower = (input || '').toLowerCase().trim();
  return cropMapping[lower] || input;
}


function isAiChatActive(farmerId) {
  const mode = aiChatModes[farmerId];
  if (!mode || !mode.active) return false;
  if (Date.now() - mode.startedAt > AI_CHAT_TIMEOUT_MS) {
    delete aiChatModes[farmerId];
    return false;
  }
  return true;
}

function activateAiChat(farmerId) {
  aiChatModes[farmerId] = { active: true, startedAt: Date.now() };
}

function deactivateAiChat(farmerId) {
  delete aiChatModes[farmerId];
}

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

// --- BUDGET & RATE LIMIT CHECK ---
async function checkRateLimits(farmerId, farmerLanguage) {
  try {
    let settings = {};
    try {
      if (!global._settingsCache || Date.now() - global._settingsCacheTime > 300000) {
        const sResp = await axios.get(ADMIN_API_URL + '/api/v1/public/settings').catch(() => null);
        if (sResp && sResp.data) {
          global._settingsCache = sResp.data.settings || {};
          global._settingsCacheTime = Date.now();
        }
      }
      settings = global._settingsCache || {};
    } catch (e) { /* use defaults */ }

    const dailyLimitPerFarmer = parseInt(settings.ai_daily_limit_per_farmer || '100');
    const dailyLimitGlobal = parseInt(settings.ai_daily_limit_global || '2000');
    const ratePerMinute = parseInt(settings.ai_rate_limit_per_minute || '5');
    const overLimitMsg = (farmerLanguage === 'en')
      ? (settings.ai_over_limit_message_en || 'You have reached your daily message limit. Let us chat again tomorrow!')
      : (settings.ai_over_limit_message_hi || 'Aaj ke liye aapki message limit poori ho gayi hai. Kal phir baat karte hain!');

    // Count only AI calls (usage_tracking), not all messages
    const farmerDaily = await pool.query(
      "SELECT COUNT(*) as cnt FROM usage_tracking WHERE farmer_id=$1 AND created_at > NOW() - INTERVAL '24 hours'",
      [farmerId]
    );
    if (parseInt(farmerDaily.rows[0].cnt) >= dailyLimitPerFarmer) {
      return { blocked: true, reason: 'farmer_daily', message: overLimitMsg };
    }

    // Per-minute rate limit (all inbound messages to prevent spam)
        const farmerRate = await pool.query(
      "SELECT COUNT(*) as cnt FROM usage_tracking WHERE farmer_id=$1 AND created_at > NOW() - INTERVAL '1 minute'",
      [farmerId]
    );

    if (parseInt(farmerRate.rows[0].cnt) >= ratePerMinute) {
      return { blocked: true, reason: 'rate_limit', message: farmerLanguage === 'en' ? 'Please wait a moment before sending more messages.' : 'Kripya thodi der baad message karein.' };
    }

    // Global daily AI calls
    const globalDaily = await pool.query(
      "SELECT COUNT(*) as cnt FROM usage_tracking WHERE created_at > NOW() - INTERVAL '24 hours'"
    );
    if (parseInt(globalDaily.rows[0].cnt) >= dailyLimitGlobal) {
      return { blocked: true, reason: 'global_daily', message: overLimitMsg };
    }

    // Monthly budget
    const monthlyBudget = parseFloat(settings.ai_monthly_budget_inr || '2000');
    try {
      const monthlySpend = await pool.query(
        "SELECT COALESCE(SUM(cost_inr), 0) as total FROM usage_tracking WHERE created_at > DATE_TRUNC('month', NOW())"
      );
      const spent = parseFloat(monthlySpend.rows[0].total || 0);
      if (spent >= monthlyBudget) {
        return { blocked: true, reason: 'monthly_budget', message: farmerLanguage === 'en' ? 'Our service is temporarily paused. Please try again next month.' : 'Hamari seva abhi ke liye band hai. Kripya agle mahine phir koshish karein.' };
      }
    } catch (e) { /* skip */ }

    return { blocked: false };
  } catch (e) {
    console.error('Rate limit check error:', e.message);
    return { blocked: false };
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

  return 'You are "VartMap AI Krishi Sahayak" - an AI agricultural assistant for Indian farmers, by Vartmaan Fertilizers (RCG Agro Private Limited).\n\n' +
    'BRAND IDENTITY:\n' +
    '- Full name: VartMap AI Krishi Sahayak\n' +
    '- Tagline: "VartMap: Aapki Kheti Ka Digital Map"\n' +
    '- You represent Vartmaan Fertilizers exclusively\n' +
    '- Naturally use the word "map" in conversations where it fits, for example:\n' +
    '  * "Chaliye aapki fasal ki sehat ka map banate hain"\n' +
    '  * "Aapki mitti ka nutrition map dekhte hain"\n' +
    '  * "Hum aapki kheti ka poora roadmap bana sakte hain"\n' +
    '  * "Yeh raha aapki samasya ka solution map"\n' +
    '- Do NOT force "map" into every message - use it only when it sounds natural (roughly 1 in 3-4 messages)\n' +
    '- Sign off important advice with: "VartMap - Aapki Kheti Ka Digital Map 🌾"\n\n' +
    'STRICT RULES (NEVER VIOLATE):\n' +
    '1. You discuss topics related to: agriculture, farming, crops, soil, fertilizers, pesticides, irrigation, weather for farming, government agricultural schemes, mandi/market prices for crops, Vartmaan Fertilizers products, AND anything about Vartmaan Fertilizers as a company (vision, mission, values, brand story, contact info, etc.).\n' +
    '2. If a farmer asks about topics completely unrelated to agriculture or Vartmaan (movies, cricket, politics, entertainment, personal advice, etc.), politely redirect: "Main kheti-kisaani aur Vartmaan Fertilizers se jude sawaalon mein madad kar sakta hoon. Kripya apni fasal ya hamare products se juda koi sawal poochein."\n' +
    '3. NEVER mention, discuss, compare, or recommend ANY competitor brand or product by name. Competitors include but are not limited to: Tata Rallis, UPL, Bayer, Syngenta, IFFCO, Coromandel, Zuari, Chambal, Rashtriya Chemicals, Deepak Fertilizers, Godrej Agrovet, PI Industries, Dhanuka, Crystal Crop, and any other brand.\n' +
    '4. If asked about competitor products, say: "Main sirf Vartmaan Fertilizers ke products ke baare mein jaankari de sakta hoon. Hamare products aapki fasal ke liye sabse behtareen hain."\n' +
    '5. You ONLY recommend Vartmaan Fertilizers products from the catalog below. Never invent or suggest products not in the catalog.\n\n' +
    'ROLE:\n' +
    '- You are a helpful, knowledgeable agricultural advisor who speaks like a friendly local expert\n' +
    '- Address farmers warmly by name (e.g., "Devashish ji", "Kisan bhai")\n' +
    '- You recommend Vartmaan Fertilizers products when relevant to the farmer\'s problem\n' +
    '- You help with crop advice, soil health, pest/disease identification, weather guidance, government schemes, and mandi prices\n' +
    '- Keep responses concise (under 300 words) since this is WhatsApp\n' +
    '- Use simple Hindi that even a basic-education farmer understands - avoid English jargon\n\n' +
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
          userParts.push({ text: (messageText ? messageText + '\n\n' : '') + 'IMPORTANT: First identify the plant/crop species visible in the image based ONLY on what you see (leaf shape, color, texture, stem structure). Do NOT assume it is the farmer\'s registered crop. Then analyze for any disease, pest damage, or nutrient deficiency. Describe what you observe in the image, give your diagnosis, and recommend treatment using Vartmaan Fertilizers products if applicable. If you cannot confidently identify the plant, say so and ask the farmer to confirm the crop name.' });
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

    // Log AI usage cost
    try {
      const inputChars = (messageText || '').length + (systemPrompt ? systemPrompt.length : 0);
      const outputChars = response.length;
      // Estimated token counts (1 token ≈ 4 chars for English, 2 chars for Hindi)
      const inputTokens = Math.ceil(inputChars / 3);
      const outputTokens = Math.ceil(outputChars / 3);
      // Cost estimation per model (INR per 1M tokens)
      const costRates = {
        'gemini-2.5-flash-lite': { input: 0.60, output: 2.40 },
        'gemini-2.0-flash': { input: 0.80, output: 3.20 },
        'gemini-2.5-flash': { input: 1.20, output: 4.80 },
        'groq-llama-3.3-70b': { input: 0.50, output: 0.80 }
      };
      const rate = costRates[modelUsed] || { input: 1.0, output: 3.0 };
      const costInr = ((inputTokens * rate.input) + (outputTokens * rate.output)) / 1000000;

      axios.post(ADMIN_API_URL + '/api/v1/public/usage/log', {
        farmer_id: farmerId,
        feature: (messageType === 'image') ? 'ai_image_analysis' : (messageType === 'audio' ? 'ai_voice' : 'ai_chat'),
        model: modelUsed,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_inr: parseFloat(costInr.toFixed(6)),
        session_id: sessionId
      }).catch(e => console.log('Usage log error:', e.message));
    } catch (costErr) {
      console.log('Cost calc error:', costErr.message);
    }

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

// --- LOCATION REQUEST ---
async function sendLocationRequest(to, bodyText) {
  try {
    const resp = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'location_request_message',
          body: { text: bodyText },
          action: { name: 'send_location' }
        }
      },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[Location Request] Sent to ${to}, msgId: ${resp.data?.messages?.[0]?.id}`);
    return true;
  } catch (err) {
    console.error(`[Location Request] Failed for ${to}:`, err.response?.data || err.message);
    return false;
  }
}

// --- INTERACTIVE LIST MESSAGE ---
async function sendInteractiveList(to, headerText, bodyText, buttonText, sections) {
  try {
    const resp = await axios.post(
      `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: { type: 'text', text: headerText },
          body: { text: bodyText },
          action: { button: buttonText, sections }
        }
      },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[Interactive List] Sent to ${to}, msgId: ${resp.data?.messages?.[0]?.id}`);
    return true;
  } catch (err) {
    console.error(`[Interactive List] Failed for ${to}:`, err.response?.data || err.message);
    return false;
  }
}

// --- REVERSE GEOCODE (Nominatim - free, no API key) ---
async function reverseGeocode(lat, lon) {
  try {
    const resp = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon, format: 'json', addressdetails: 1, 'accept-language': 'en' },
      headers: { 'User-Agent': 'VartMap-KrishiBot/1.0' }
    });
    const addr = resp.data?.address || {};
    return {
      village: addr.village || addr.town || addr.city || addr.suburb || '',
      district: addr.county || addr.state_district || addr.district || '',
      state: addr.state || '',
      pin_code: addr.postcode || '',
      full_address: resp.data?.display_name || '',
      raw: addr
    };
  } catch (err) {
    console.error('[ReverseGeocode] Error:', err.message);
    return null;
  }
}

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
async function handleOnboarding(farmerId, farmerData, from, msgBody, sessionId, botConfig, messageObj) {
  const stage = farmerData.onboarding_stage || 'new';
  const lang = farmerData.language || 'hi';

  switch (stage) {
    case 'new': {
      const welcome = lang === 'hi' ? botConfig.welcome_hi : botConfig.welcome_en;
      await sendWhatsAppMessage(from, welcome);
      const askName = lang === 'hi'
        ? 'Sabse pehle, aapka shubh naam kya hai?'
        : 'First, what is your name?';
      await sendWhatsAppMessage(from, askName);
      await pool.query("UPDATE farmers SET onboarding_stage = 'awaiting_name', updated_at = NOW() WHERE id = $1", [farmerId]);
      await pool.query(
        "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
        [sessionId, farmerId, welcome + '\n' + askName]
      );
      return true;
    }

    case 'awaiting_name': {
      const name = msgBody.trim().substring(0, 100);
      if (!name || name.length < 2) {
        await sendWhatsAppMessage(from, lang === 'hi'
          ? 'Kripya apna naam batayein (kam se kam 2 akshar):'
          : 'Please tell your name (at least 2 characters):');
        return true;
      }
      await pool.query(
        "UPDATE farmers SET name = $1, onboarding_stage = 'awaiting_location', updated_at = NOW() WHERE id = $2",
        [name, farmerId]
      );
      const locMsg = lang === 'hi'
        ? `Dhanyavaad ${name} ji! Ab apni kheti ki location share karein - neeche "Share Location" button dabayein. Isse hum aapke kshetra ki mandi, mausam aur mitti ki jaankari de payenge.\n\nAgar aap skip karna chahein toh "skip" likhein.`
        : `Thank you ${name}! Now please share your farm location by tapping "Share Location" below. This helps us provide local mandi prices, weather & soil info.\n\nType "skip" to continue without sharing location.`;
      await sendLocationRequest(from, locMsg);
      await pool.query(
        "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
        [sessionId, farmerId, locMsg]
      );
      return true;
    }

    case 'awaiting_location': {
      const locData = messageObj?.location;
      if (locData && locData.latitude && locData.longitude) {
        const geo = await reverseGeocode(locData.latitude, locData.longitude);
        const locationJson = {
          latitude: locData.latitude,
          longitude: locData.longitude,
          ...(geo || {})
        };
        await pool.query(
          `UPDATE farmers SET location = $1, village = $2, pin_code = $3, onboarding_stage = 'awaiting_crops', updated_at = NOW() WHERE id = $4`,
          [JSON.stringify(locationJson), geo?.village || '', geo?.pin_code || '', farmerId]
        );
        const confirmLoc = lang === 'hi'
          ? `Location mil gayi! ${geo?.village ? geo.village + ', ' : ''}${geo?.district || ''}, ${geo?.state || ''}\n\nAb apni mukhya fasal chunein:`
          : `Got your location! ${geo?.village ? geo.village + ', ' : ''}${geo?.district || ''}, ${geo?.state || ''}\n\nNow select your main crop:`;
        const sections = [{
          title: lang === 'hi' ? 'Pramukh Fasalein' : 'Major Crops',
          rows: [
            { id: 'crop_rice', title: lang === 'hi' ? 'Dhaan (Chawal)' : 'Rice', description: '' },
            { id: 'crop_wheat', title: lang === 'hi' ? 'Gehun' : 'Wheat', description: '' },
            { id: 'crop_cotton', title: lang === 'hi' ? 'Kapas' : 'Cotton', description: '' },
            { id: 'crop_sugarcane', title: lang === 'hi' ? 'Ganna' : 'Sugarcane', description: '' },
            { id: 'crop_soybean', title: lang === 'hi' ? 'Soyabean' : 'Soybean', description: '' },
            { id: 'crop_maize', title: lang === 'hi' ? 'Makka' : 'Maize', description: '' },
            { id: 'crop_tomato', title: lang === 'hi' ? 'Tamatar' : 'Tomato', description: '' },
            { id: 'crop_onion', title: lang === 'hi' ? 'Pyaaz' : 'Onion', description: '' },
            { id: 'crop_potato', title: lang === 'hi' ? 'Aloo' : 'Potato', description: '' },
            { id: 'crop_banana', title: lang === 'hi' ? 'Kela' : 'Banana', description: '' }
          ]
        }];
        await sendWhatsAppMessage(from, confirmLoc);
        await sendInteractiveList(
          from,
          lang === 'hi' ? 'Fasal Chunein' : 'Select Crop',
          lang === 'hi' ? 'Apni mukhya fasal chunein (baad mein aur jod sakte hain):' : 'Select your main crop (you can add more later):',
          lang === 'hi' ? 'Fasal Dekhein' : 'View Crops',
          sections
        );
        return true;
      } else if (msgBody.toLowerCase().includes('skip') || msgBody.includes('\u091B\u094B\u0921\u093C')) {
        await pool.query("UPDATE farmers SET onboarding_stage = 'awaiting_crops', updated_at = NOW() WHERE id = $1", [farmerId]);
        const skipMsg = lang === 'hi'
          ? 'Koi baat nahi! Baad mein location share kar sakte hain.\n\nAb apni mukhya fasal chunein:'
          : 'No problem! You can share location later.\n\nNow select your main crop:';
        const sections = [{
          title: lang === 'hi' ? 'Pramukh Fasalein' : 'Major Crops',
          rows: [
            { id: 'crop_rice', title: lang === 'hi' ? 'Dhaan (Chawal)' : 'Rice', description: '' },
            { id: 'crop_wheat', title: lang === 'hi' ? 'Gehun' : 'Wheat', description: '' },
            { id: 'crop_cotton', title: lang === 'hi' ? 'Kapas' : 'Cotton', description: '' },
            { id: 'crop_sugarcane', title: lang === 'hi' ? 'Ganna' : 'Sugarcane', description: '' },
            { id: 'crop_soybean', title: lang === 'hi' ? 'Soyabean' : 'Soybean', description: '' },
            { id: 'crop_maize', title: lang === 'hi' ? 'Makka' : 'Maize', description: '' },
            { id: 'crop_tomato', title: lang === 'hi' ? 'Tamatar' : 'Tomato', description: '' },
            { id: 'crop_onion', title: lang === 'hi' ? 'Pyaaz' : 'Onion', description: '' },
            { id: 'crop_potato', title: lang === 'hi' ? 'Aloo' : 'Potato', description: '' },
            { id: 'crop_banana', title: lang === 'hi' ? 'Kela' : 'Banana', description: '' }
          ]
        }];
        await sendWhatsAppMessage(from, skipMsg);
        await sendInteractiveList(
          from,
          lang === 'hi' ? 'Fasal Chunein' : 'Select Crop',
          lang === 'hi' ? 'Apni mukhya fasal chunein:' : 'Select your main crop:',
          lang === 'hi' ? 'Fasal Dekhein' : 'View Crops',
          sections
        );
        return true;
      } else {
        const retry = lang === 'hi'
          ? 'Kripya neeche "Share Location" button dabayein, ya skip karne ke liye "skip" likhein.'
          : 'Please tap "Share Location" button below, or type "skip" to continue.';
        await sendLocationRequest(from, retry);
        return true;
      }
    }

    case 'awaiting_crops': {
      let selectedCrop = '';
      if (messageObj?.interactive?.type === 'list_reply') {
        selectedCrop = messageObj.interactive.list_reply.title;
      } else if (msgBody.trim()) {
        selectedCrop = msgBody.trim();
      }
      if (!selectedCrop || selectedCrop.length < 2) {
        await sendWhatsAppMessage(from, lang === 'hi' ? 'Kripya apni fasal batayein ya list se chunein:' : 'Please tell your crop or select from list:');
        return true;
      }
      const crops = selectedCrop.split(',').map(c => c.trim()).filter(Boolean);
      await pool.query(
        "UPDATE farmers SET crops = $1, onboarding_stage = 'awaiting_land_size', updated_at = NOW() WHERE id = $2",
        [crops, farmerId]
      );
      const askLand = lang === 'hi'
        ? `Bahut accha! "${crops.join(', ')}" - Aapki kitni zameen hai? (acre mein likhein, jaise "5" ya "2.5")\n\nSkip karne ke liye "skip" likhein.`
        : `Great! "${crops.join(', ')}" - How much land do you have? (in acres, e.g. "5" or "2.5")\n\nType "skip" to continue without this.`;
      await sendWhatsAppMessage(from, askLand);
      return true;
    }

    case 'awaiting_land_size': {
      if (msgBody.toLowerCase().includes('skip') || msgBody.includes('\u091B\u094B\u0921\u093C')) {
        await pool.query(
          "UPDATE farmers SET onboarding_stage = 'complete', profile_complete = true, updated_at = NOW() WHERE id = $1",
          [farmerId]
        );
      } else {
        const sizeText = msgBody.replace(/[^0-9.]/g, '');
        const acres = parseFloat(sizeText);
        if (isNaN(acres) || acres <= 0 || acres > 10000) {
          await sendWhatsAppMessage(from, lang === 'hi'
            ? 'Kripya sahi sankhya likhein (jaise 2, 5, 10.5) ya "skip" likhein:'
            : 'Please enter a valid number (e.g. 2, 5, 10.5) or type "skip":');
          return true;
        }
        await pool.query(
          "UPDATE farmers SET land_holding_acres = $1, onboarding_stage = 'complete', profile_complete = true, updated_at = NOW() WHERE id = $2",
          [acres, farmerId]
        );
      }
      const complete = lang === 'hi'
        ? `Shaandaar! Aapka registration pura ho gaya.\n\nAap ab yeh kar sakte hain:\n1. Mandi Bhav - "mandi" likhein\n2. Mausam - "mausam" likhein\n3. Fasal Salah - foto bhejein\n4. Mitti Jaanch - "soil" likhein\n\nKoi bhi sawaal puchein!`
        : `Excellent! Your registration is complete.\n\nYou can now:\n1. Mandi Prices - type "mandi"\n2. Weather - type "weather"\n3. Crop Advice - send a photo\n4. Soil Info - type "soil"\n\nAsk me anything!`;
      await sendWhatsAppMessage(from, complete);
      await pool.query(
        "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
        [sessionId, farmerId, complete]
      );
      return true;
    }

    case 'complete':
      return false;

    default:
      return false;
  }
}
// --- WEATHER API ---
async function getWeather(city) {
  try {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) { console.log('No OPENWEATHER_API_KEY'); return null; }
    const resp = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
      params: { q: city + ',IN', appid: apiKey, units: 'metric', lang: 'hi' }
    });
    const d = resp.data;
    let msg = '*🌤️ ' + d.name + ' ka Mausam*\n\n';
    msg += '🌡️ *Taapman:* ' + Math.round(d.main.temp) + '°C (Min: ' + Math.round(d.main.temp_min) + '°C, Max: ' + Math.round(d.main.temp_max) + '°C)\n';
    msg += '💧 *Nami (Humidity):* ' + d.main.humidity + '%\n';
    msg += '🌬️ *Hawa:* ' + Math.round(d.wind.speed * 3.6) + ' km/h\n';
    msg += '☁️ *Haalat:* ' + d.weather[0].description + '\n';
    msg += '👁️ *Dikhai:* ' + (d.visibility / 1000).toFixed(1) + ' km\n\n';
    msg += '🌾 *Kheti Salah:* ';
    if (d.main.temp > 40) msg += 'Bahut garmi hai — subah/shaam sinchai karein, fasal ko dhoop se bachaayein.';
    else if (d.main.temp > 35) msg += 'Garmi zyada hai — sinchai ka dhyan rakhein aur mulching karein.';
    else if (d.main.humidity > 80) msg += 'Nami zyada hai — fungal rog ka dhyan rakhein, davai ka chhidkaav karein.';
    else if (d.wind.speed > 10) msg += 'Tez hawa — chhidkaav se bachein, fasal ko support dein.';
    else msg += 'Mausam anukool hai — kheti ka kaam jari rakhein.';
    msg += '\n\n_VartMap - Aapki Kheti Ka Digital Map 🌾_';
    return msg;
  } catch (e) {
    console.error('Weather API error:', e.message);
    return null;
  }
}

// --- MANDI PRICE LOOKUP ---
async function getMandiPrices(crop, state, district) {
  try {
    const params = new URLSearchParams();
    if (crop) params.append('commodity', crop);
    if (state) params.append('state', state);
    if (district) params.append('district', district);
    params.append('limit', '10');
    const resp = await axios.get(ADMIN_API_URL + '/api/v1/public/mandi-prices?' + params.toString());
    return resp.data.prices || [];
  } catch (e) { console.log('Mandi fetch error:', e.message); return []; }
}


function formatMandiPrices(prices, crop) {
  if (!prices.length) return 'Maaf kijiye, "' + (crop || '') + '" ke liye abhi mandi bhav uplabdh nahi hai.';
  let msg = '*🌾 Mandi Bhav - ' + (crop || prices[0].commodity) + '*\n\n';
  prices.forEach(p => {
    msg += '📍 *' + (p.market_name || p.district) + '* (' + (p.state || '') + ')\n';
    msg += '   Min: ₹' + p.min_price + ' | Max: ₹' + p.max_price + ' | Modal: ₹' + p.modal_price + '/' + (p.unit || 'quintal') + '\n';
    if (p.price_date) msg += '   📅 ' + new Date(p.price_date).toLocaleDateString('hi-IN') + '\n';
    msg += '\n';
  });
  msg += '_Mandi bhav samay ke saath badal sakte hain._';
  return msg;
}

// --- GOVERNMENT SCHEMES LOOKUP ---
async function getGovtSchemes(state) {
  try {
    const params = new URLSearchParams();
    if (state) params.append('state', state);
    params.append('limit', '10');
    const resp = await axios.get(ADMIN_API_URL + '/api/v1/public/schemes?' + params.toString());
    return resp.data.schemes || [];
  } catch (e) { console.log('Schemes fetch error:', e.message); return []; }
}

function formatGovtSchemes(schemes, farmer) {
  if (!schemes.length) return 'Maaf kijiye, abhi koi sarkari yojana ki jankari uplabdh nahi hai.';
  let msg = '*🏛️ Sarkari Yojanayen*\n\n';
  schemes.slice(0, 5).forEach((s, i) => {
    msg += (i + 1) + '. *' + (s.name_hi || s.name) + '*\n';
    if (s.description) msg += '   ' + s.description.substring(0, 100) + '\n';
    if (s.benefits) msg += '   ✅ ' + s.benefits.substring(0, 80) + '\n';
    if (s.helpline) msg += '   📞 ' + s.helpline + '\n';
    if (s.apply_url) msg += '   🔗 ' + s.apply_url + '\n';
    msg += '\n';
  });
  msg += '_Adhik jankari ke liye helpline par call karein._';
  return msg;
}

// --- SOIL DATA LOOKUP ---
async function getSoilData(state, district) {
  try {
    const params = new URLSearchParams();
    if (state) params.append('state', state);
    if (district) params.append('district', district);
    const resp = await axios.get(ADMIN_API_URL + '/api/v1/public/soil-data?' + params.toString());
    return resp.data.data || [];
  } catch (e) { console.log('Soil fetch error:', e.message); return []; }
}

function formatSoilData(soilData, district) {
  if (!soilData.length) return 'Maaf kijiye, "' + (district || 'aapke area') + '" ke liye mitti ki jankari uplabdh nahi hai.';
  const s = soilData[0];
  let msg = '*\uD83C\uDF0D Mitti ki Jankari - ' + (s.district_name || district) + (s.block_name ? ', ' + s.block_name : '') + '*\n';
  msg += (s.state_name || '') + ' | Cycle: ' + (s.cycle || s.sample_year || '') + '\n';
  msg += (s.scheme_name ? 'Scheme: ' + s.scheme_name + '\n' : '');
  msg += '\n';

  msg += '\uD83D\uDCCA *Primary Nutrients (Low/Med/High %):*\n';
  msg += '\u2022 *Nitrogen (N):* ' + s.nitrogen_low_pct + '% / ' + s.nitrogen_medium_pct + '% / ' + s.nitrogen_high_pct + '%\n';
  msg += '\u2022 *Phosphorus (P):* ' + s.phosphorus_low_pct + '% / ' + s.phosphorus_medium_pct + '% / ' + s.phosphorus_high_pct + '%\n';
  msg += '\u2022 *Potassium (K):* ' + s.potassium_low_pct + '% / ' + s.potassium_medium_pct + '% / ' + s.potassium_high_pct + '%\n';
  msg += '\u2022 *Organic Carbon:* ' + (s.organic_carbon_low_pct || '-') + '% / ' + (s.organic_carbon_medium_pct || '-') + '% / ' + (s.organic_carbon_high_pct || '-') + '%\n\n';

  msg += '\uD83E\uDDEA *Micro Nutrients (Sufficient/Deficient %):*\n';
  if (s.sulphur_sufficient_pct != null || s.avg_sulphur != null) msg += '\u2022 *Sulphur (S):* ' + (s.sulphur_sufficient_pct || s.avg_sulphur || 0) + '% suff / ' + (s.sulphur_deficient_pct || (100-(s.avg_sulphur||0))) + '% def ' + ((s.sulphur_deficient_pct||100-(s.avg_sulphur||0)) > 70 ? '\u26A0\uFE0F' : '\u2705') + '\n';
  if (s.iron_sufficient_pct != null || s.avg_iron != null) msg += '\u2022 *Iron (Fe):* ' + (s.iron_sufficient_pct || s.avg_iron || 0) + '% suff / ' + (s.iron_deficient_pct || (100-(s.avg_iron||0))) + '% def ' + ((s.iron_deficient_pct||100-(s.avg_iron||0)) > 50 ? '\u26A0\uFE0F' : '\u2705') + '\n';
  if (s.zinc_sufficient_pct != null || s.avg_zinc != null) msg += '\u2022 *Zinc (Zn):* ' + (s.zinc_sufficient_pct || s.avg_zinc || 0) + '% suff / ' + (s.zinc_deficient_pct || (100-(s.avg_zinc||0))) + '% def ' + ((s.zinc_deficient_pct||100-(s.avg_zinc||0)) > 50 ? '\u26A0\uFE0F' : '\u2705') + '\n';
  if (s.copper_sufficient_pct != null || s.avg_copper != null) msg += '\u2022 *Copper (Cu):* ' + (s.copper_sufficient_pct || s.avg_copper || 0) + '% suff / ' + (s.copper_deficient_pct || (100-(s.avg_copper||0))) + '% def ' + ((s.copper_deficient_pct||100-(s.avg_copper||0)) > 50 ? '\u26A0\uFE0F' : '\u2705') + '\n';
  if (s.boron_sufficient_pct != null || s.avg_boron != null) msg += '\u2022 *Boron (B):* ' + (s.boron_sufficient_pct || s.avg_boron || 0) + '% suff / ' + (s.boron_deficient_pct || (100-(s.avg_boron||0))) + '% def ' + ((s.boron_deficient_pct||100-(s.avg_boron||0)) > 50 ? '\u26A0\uFE0F' : '\u2705') + '\n';
  if (s.manganese_sufficient_pct != null || s.avg_manganese != null) msg += '\u2022 *Manganese (Mn):* ' + (s.manganese_sufficient_pct || s.avg_manganese || 0) + '% suff / ' + (s.manganese_deficient_pct || (100-(s.avg_manganese||0))) + '% def ' + ((s.manganese_deficient_pct||100-(s.avg_manganese||0)) > 50 ? '\u26A0\uFE0F' : '\u2705') + '\n';
  msg += '\n';

  msg += '\u2696\uFE0F *pH & EC:*\n';
  msg += '\u2022 *pH:* ' + (s.avg_ph || '-') + ' (' + (s.soil_type || '-') + ')\n';
  if (s.ph_alkaline_pct || s.ph_neutral_pct || s.ph_acidic_pct) msg += '   Alkaline: ' + (s.ph_alkaline_pct||0) + '% | Neutral: ' + (s.ph_neutral_pct||0) + '% | Acidic: ' + (s.ph_acidic_pct||0) + '%\n';
  if (s.ec_non_saline_pct || s.ec_saline_pct) msg += '\u2022 *EC:* Non-Saline: ' + (s.ec_non_saline_pct||0) + '% | Saline: ' + (s.ec_saline_pct||0) + '%\n';
  msg += '\u2022 *Samples:* ' + (s.total_samples || '-') + '\n\n';

  // Show AI recommendations if available
  const recs = typeof s.recommendations === 'string' ? JSON.parse(s.recommendations || '{}') : (s.recommendations || {});
  const recKeys = Object.keys(recs);
  if (recKeys.length) {
    msg += '\uD83D\uDCA1 *Salah (Recommendations):*\n';
    recKeys.forEach(k => { msg += '\u2022 ' + recs[k] + '\n'; });
    msg += '\n';
  }

  msg += '_\uD83C\uDF3E Source: soilhealth.dac.gov.in | Mitti test karwayen aur Vartmaan se sampark karein._';
  return msg;
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

    // --- DATA-DRIVEN MENU HANDLERS ---
  const menuKey = (matchedMenu.menu_key || '').toLowerCase();

  // MANDI PRICES
  if (menuKey === 'mandi_prices') {
    const crops = Array.isArray(farmerData.crops) ? farmerData.crops : (farmerData.crops || '').split(',');
    const primaryCrop = crops[0] ? translateCrop(crops[0].trim()) : '';
    if (primaryCrop) {
      await sendWhatsAppMessage(from, lang === 'hi' ? '🌾 "' + primaryCrop + '" ka mandi bhav dhundh raha hoon...' : 'Looking up mandi prices for "' + primaryCrop + '"...');
      let prices = await getMandiPrices(primaryCrop, '');
      if (!prices.length) prices = await getMandiPrices(crops[0].trim(), '');
      const reply = formatMandiPrices(prices, primaryCrop);
      await sendWhatsAppMessage(from, reply);
    }
    // Show crop selection list for next lookup
    setPendingAction(farmerId, 'mandi_crop');
    await sendWhatsAppList(from,
      lang === 'hi' ? '🌾 Kis fasal ka bhav dekhna hai? Neeche se chunein ya naam type karein:' : 'Select a crop or type its name:',
      'Fasal Chunein',
      [{ title: 'Pramukh Fasalein', rows: popularCrops }]
    );
    return true;
  }




  // GOVERNMENT SCHEMES
  if (menuKey === 'govt_schemes' || menuKey === 'government_schemes' || menuKey === 'sarkari_yojana') {
    await sendWhatsAppMessage(from, lang === 'hi' ? '🏛️ Sarkari yojanayen dhundh raha hoon...' : 'Looking up government schemes...');
    const schemes = await getGovtSchemes(farmerData.state_name || '');
    const reply = formatGovtSchemes(schemes, farmerData);
    await sendWhatsAppMessage(from, reply);
    await sendMenuMessage(from, botConfig, lang);
    return true;
  }


  // SOIL INFO
  if (menuKey === 'soil_info' || menuKey === 'mitti') {
    const district = farmerData.district || farmerData.village || '';
    if (district) {
      await sendWhatsAppMessage(from, lang === 'hi' ? '🌍 "' + district + '" ki mitti ki jankari dhundh raha hoon...' : 'Looking up soil data for "' + district + '"...');
      const soilData = await getSoilData('', district);
      const reply = formatSoilData(soilData, district);
      await sendWhatsAppMessage(from, reply);
    }
    // Show district selection
    setPendingAction(farmerId, 'soil_district');
    if (popularDistricts.length <= 3) {
      await sendWhatsAppButtons(from,
        lang === 'hi' ? '🌍 Kis district ki mitti ki jankari chahiye? Chunein ya naam type karein:' : 'Select district or type name:',
        popularDistricts.map(d => ({ id: d.id, title: d.title }))
      );
    } else {
      await sendWhatsAppList(from,
        lang === 'hi' ? '🌍 Kis district ki mitti ki jankari chahiye? Chunein ya naam type karein:' : 'Select district or type name:',
        'District Chunein',
        [{ title: 'Districts', rows: popularDistricts }]
      );
    }
    return true;
  }




  // WEATHER
  if (menuKey === 'weather' || menuKey === 'mausam') {
    const district = farmerData.district || farmerData.village || '';
    if (district) {
      await sendWhatsAppMessage(from, lang === 'hi' ? '🌤️ "' + district + '" ka mausam dhundh raha hoon...' : 'Looking up weather for "' + district + '"...');
      const weatherMsg = await getWeather(district);
      if (weatherMsg) {
        await sendWhatsAppMessage(from, weatherMsg);
        setPendingAction(farmerId, 'weather_city');
        await sendWhatsAppMessage(from, lang === 'hi' ? 'Kisi aur shehar ka mausam jaanne ke liye naam likhen, ya "menu" type karein.' : 'Type another city name, or type "menu".');
      } else {
        await sendWhatsAppMessage(from, lang === 'hi' ? '❌ "' + district + '" ka mausam nahi mil paya. Kripya sahi shehar/district naam likhen.' : 'Could not find weather for "' + district + '". Please type correct city name.');
        setPendingAction(farmerId, 'weather_city');
      }
    } else {
      setPendingAction(farmerId, 'weather_city');
      await sendWhatsAppMessage(from, lang === 'hi'
        ? '🌤️ Mausam ki jankari ke liye apna shehar/district type karein (jaise: Karnal, Lucknow, Indore)'
        : 'Type your city/district name for weather info');
    }
    return true;
  }


  // MY PROFILE
  if (menuKey === 'my_profile' || menuKey === 'profile') {
    const f = farmerData;
    const crops = Array.isArray(f.crops) ? f.crops.join(', ') : (f.crops || 'Not set');
    let profileMsg = '*👨‍🌾 Meri Profile*\n\n';
    profileMsg += '📛 *Naam:* ' + (f.name || '-') + '\n';
    profileMsg += '📱 *Phone:* ' + (f.phone || '-') + '\n';
    profileMsg += '🌐 *Bhaasha:* ' + (f.language === 'hi' ? 'Hindi' : f.language === 'en' ? 'English' : (f.language || '-')) + '\n';
    profileMsg += '🏘️ *Gaon:* ' + (f.village || '-') + '\n';
    profileMsg += '🌾 *Fasalein:* ' + crops + '\n';
    profileMsg += '🏞️ *Zameen:* ' + (f.land_holding_acres ? f.land_holding_acres + ' acre' : 'Not set') + '\n';
    profileMsg += '🧪 *Mitti:* ' + (f.soil_type || 'Not set') + '\n';
    profileMsg += '💧 *Sinchai:* ' + (f.irrigation_type || 'Not set') + '\n';
    profileMsg += '🌿 *Kheti ka tarika:* ' + (f.farming_type || 'Not set') + '\n\n';
    profileMsg += '_"menu" type karein aur options dekhein._';
    await sendWhatsAppMessage(from, profileMsg);
    return true;
  }



  // FERTILIZER ADVICE
  if (menuKey === 'fertilizer_advice') {
    setPendingAction(farmerId, 'fertilizer_crop');
    await sendWhatsAppList(from,
      lang === 'hi'
        ? '🧪 *Khad Salah*\n\nKis fasal ke liye khad ki salah chahiye? Neeche se chunein ya fasal ka naam type karein:'
        : 'Which crop do you need fertilizer advice for?',
      'Fasal Chunein',
      [{ title: 'Pramukh Fasalein', rows: popularCrops }]
    );
    activateAiChat(farmerId);
    return true;
  }


  // CROP DOCTOR
  if (menuKey === 'crop_doctor') {
    setPendingAction(farmerId, 'crop_doctor_photo');
    await sendWhatsAppMessage(from, lang === 'hi'
      ? '🔬 *Fasal Doctor*\n\nApni beemaar fasal ki photo bhejein, hum AI se bimari pahchaanenge!\n\n📸 *Photo kaise lein:*\n• Paas se lein (close-up)\n• Rog wali patti ya hissa dikhayein\n• Acchi roshni mein lein\n\nPhoto bhejein ya samasya likhen:'
      : '🔬 *Crop Doctor*\n\nSend a photo of the affected crop for AI diagnosis!\n\n📸 *Photo tips:*\n• Take a close-up\n• Show the affected leaf/part\n• Good lighting\n\nSend photo or describe the problem:');
    activateAiChat(farmerId);
    return true;
  }


  // MODERN FARMING
  if (menuKey === 'modern_farming') {
    await sendWhatsAppMessage(from, lang === 'hi'
      ? '🌱 *Adhunik Kheti*\n\nAap kisi bhi kheti se judi jaankari poochh sakte hain:\n• Nayi techniques\n• Beej aur ugaane ka tarika\n• Keetnashak aur dawaiyan\n• Organic kheti\n\nApna sawaal poochhein:'
      : '🌱 *Modern Farming*\n\nAsk about any farming topic:\n• New techniques\n• Seeds & cultivation\n• Pest management\n• Organic farming\n\nAsk your question:');
    activateAiChat(farmerId);
    return true;
  }


    // AI CHAT MODE
  if (menuKey === 'ai_chat' || menuKey === 'ai_se_baat') {
    activateAiChat(farmerId);
    await sendWhatsAppMessage(from, lang === 'hi'
      ? '🤖 *AI Chat Mode ON*\n\nAap ab AI se seedha baat kar sakte hain. Apna sawaal poochhein!\n\n⏱️ 10 minute baad menu wapas aa jayega.\n📋 Menu dekhne ke liye "menu" type karein.'
      : '🤖 *AI Chat Mode ON*\n\nYou can now chat directly with AI. Ask your question!\n\n⏱️ Session expires in 10 minutes.\n📋 Type "menu" to go back.');
    return true;
  }

  // TALK TO EXPERT
  if (menuKey === 'talk_to_expert') {
    await sendWhatsAppMessage(from, lang === 'hi'
      ? '👨‍🔬 Aapka sandesh hamare visheshagya ko bhej diya gaya hai. Woh jaldi se aapko call karenge.\n\n📞 Seedha baat karne ke liye call karein: 1800-XXX-XXXX\n\n_"menu" type karein aur options dekhein._'
      : 'Your message has been forwarded to our expert. They will call you soon.\n\n📞 Direct call: 1800-XXX-XXXX\n\nType "menu" for options.');
    return true;
  }



  // Default: let AI handle
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

        // Handle delivery status updates (sent/delivered/read/failed)
        const statuses = value.statuses || [];
        if (statuses.length) console.log('Status updates received:', statuses.length, statuses.map(s => s.status + ':' + s.id).join(', '));
        for (const status of statuses) {
          try {
            const waId = status.id;
            const statusVal = status.status;
            const timestamp = status.timestamp ? new Date(status.timestamp * 1000) : new Date();
            if (statusVal === 'delivered') {
              await pool.query('UPDATE campaign_messages SET status=$1, delivered_at=$2 WHERE wa_message_id=$3', ['delivered', timestamp, waId]);
            } else if (statusVal === 'read') {
              await pool.query('UPDATE campaign_messages SET status=$1, read_at=$2 WHERE wa_message_id=$3', ['read', timestamp, waId]);
            } else if (statusVal === 'failed') {
              const errMsg = status.errors && status.errors[0] ? status.errors[0].title : 'Unknown error';
              await pool.query('UPDATE campaign_messages SET status=$1, error_message=$2 WHERE wa_message_id=$3', ['failed', errMsg, waId]);
            }
            await pool.query('UPDATE wa_messages SET wa_status=$1 WHERE wa_message_id=$2', [statusVal, waId]);
          } catch (se) { console.error('Status update error:', se.message); }
        }


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
          if (msg.type === 'location') { msgBody = '[location shared]'; }
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
          const storedMsgType = (msgType === 'voice') ? 'audio' : (msgType === 'interactive' ? 'text' : (msgType === 'location' ? 'location' : msgType));
          await pool.query(
            "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_message_id, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'inbound', 'farmer', $3, $4, $5, 'delivered', NOW())",
            [sessionId, farmerId, storedMsgType, msgBody || '[' + msgType + ']', waMessageId]
          );

          // 5. ONBOARDING CHECK (new farmers)
          const onboardingStage = farmerData.onboarding_stage || 'new';
          if (onboardingStage !== 'complete' && botConfig.onboarding_enabled) {
            const handled = await handleOnboarding(farmerId, farmerData, from, msgBody, sessionId, botConfig, msg);
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

          // 6.5 HANDLE PENDING ACTIONS
          const pendingAction = getPendingAction(farmerId);
          if (pendingAction && msgBody.trim()) {
            const lang = farmerData.language || 'hi';

            if (pendingAction === 'mandi_crop') {
              clearPendingAction(farmerId);
              let crop = cropIdMapping[msgBody.trim()] || translateCrop(msgBody.trim());
              await sendWhatsAppMessage(from, lang === 'hi'
                ? '🌾 "' + crop + '" ka mandi bhav dhundh raha hoon...'
                : 'Looking up prices for "' + crop + '"...');
              let prices = await getMandiPrices(crop, '');
              if (!prices.length) prices = await getMandiPrices(msgBody.trim(), '');
              const reply = formatMandiPrices(prices, crop);
              await sendWhatsAppMessage(from, reply);
              // Get available states for this crop
              const states = [...new Set(prices.map(p => p.state).filter(Boolean))];
              if (states.length > 0) {
                const stateRows = states.slice(0, 10).map(s => ({ id: 'state_' + s.replace(/\s/g, '_'), title: s.substring(0, 24) }));
                pendingActions[farmerId] = { action: 'mandi_state', timestamp: Date.now(), crop: crop };
                await sendWhatsAppList(from,
                  lang === 'hi' ? '📍 Kisi khaas state ka bhav dekhein, ya "menu" type karein:' : 'Filter by state, or type "menu":',
                  'State Chunein',
                  [{ title: 'States', rows: stateRows }]
                );
              } else {
                setPendingAction(farmerId, 'mandi_crop');
                await sendWhatsAppList(from,
                  lang === 'hi' ? 'Kisi aur fasal ka bhav dekhein ya "menu" type karein:' : 'Check another crop or type "menu":',
                  'Fasal Chunein',
                  [{ title: 'Pramukh Fasalein', rows: popularCrops }]
                );
              }
              await pool.query(
                "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
                [sessionId, farmerId, reply]
              );
              continue;
            }

            if (pendingAction === 'mandi_state') {
              const pendingData = getPendingData(farmerId);
              clearPendingAction(farmerId);
              const crop = pendingData.crop || '';
              let state = msgBody.trim().replace('state_', '').replace(/_/g, ' ');
              // Handle list selection IDs
              if (msgBody.trim().startsWith('state_')) {
                state = msgBody.trim().replace('state_', '').replace(/_/g, ' ');
              }
              await sendWhatsAppMessage(from, lang === 'hi'
                ? '🌾 "' + crop + '" ka bhav "' + state + '" mein dhundh raha hoon...'
                : 'Looking up "' + crop + '" prices in "' + state + '"...');
              const prices = await getMandiPrices(crop, state);
              const reply = formatMandiPrices(prices, crop + ' (' + state + ')');
              await sendWhatsAppMessage(from, reply);
              // Get districts within this state
              const districts = [...new Set(prices.map(p => p.district).filter(Boolean))];
              if (districts.length > 1) {
                const distRows = districts.slice(0, 10).map(d => ({ id: 'mdist_' + d.replace(/\s/g, '_'), title: d.substring(0, 24) }));
                pendingActions[farmerId] = { action: 'mandi_district', timestamp: Date.now(), crop: crop, state: state };
                await sendWhatsAppList(from,
                  lang === 'hi' ? '📍 Kisi khaas district ka bhav dekhein, ya "menu" type karein:' : 'Filter by district, or type "menu":',
                  'District Chunein',
                  [{ title: 'Districts', rows: distRows }]
                );
              } else {
                await sendWhatsAppMessage(from, lang === 'hi'
                  ? '_"menu" type karein aur options dekhein._'
                  : '_Type "menu" for options._');
              }
              await pool.query(
                "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
                [sessionId, farmerId, reply]
              );
              continue;
            }

            if (pendingAction === 'mandi_district') {
              const pendingData = getPendingData(farmerId);
clearPendingAction(farmerId);
const crop = pendingData.crop || '';
const state = pendingData.state || '';
              let district = msgBody.trim();
              if (district.startsWith('mdist_')) {
                district = district.replace('mdist_', '').replace(/_/g, ' ');
              }
              await sendWhatsAppMessage(from, lang === 'hi'
                ? '🌾 "' + crop + '" ka bhav "' + district + '" mein dhundh raha hoon...'
                : 'Looking up "' + crop + '" prices in "' + district + '"...');
              const prices = await getMandiPrices(crop, state, district);
              const reply = formatMandiPrices(prices, crop + ' (' + district + ')');
              await sendWhatsAppMessage(from, reply);
              await sendWhatsAppMessage(from, lang === 'hi'
                ? '_"menu" type karein aur options dekhein._'
                : '_Type "menu" for options._');
              await pool.query(
                "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
                [sessionId, farmerId, reply]
              );
              continue;
            }

            if (pendingAction === 'soil_district') {
              clearPendingAction(farmerId);
              let district = districtIdMapping[msgBody.trim()] || msgBody.trim();
              await sendWhatsAppMessage(from, lang === 'hi'
                ? '🌍 "' + district + '" ki mitti ki jankari dhundh raha hoon...'
                : 'Looking up soil data for "' + district + '"...');
              const soilData = await getSoilData('', district);
              const reply = formatSoilData(soilData, district);
              await sendWhatsAppMessage(from, reply);
              await sendWhatsAppMessage(from, lang === 'hi'
                ? '_"menu" type karein aur options dekhein._'
                : '_Type "menu" for options._');
              await pool.query(
                "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
                [sessionId, farmerId, reply]
              );
              continue;
            }

            if (pendingAction === 'crop_doctor_photo') {
              // Text instead of photo - still let AI handle it
              clearPendingAction(farmerId);
              // Don't block - fall through to AI
            }

            if (pendingAction === 'fertilizer_crop') {
              clearPendingAction(farmerId);
              // Fall through to AI with crop context
            }

            if (pendingAction === 'weather_city') {
              clearPendingAction(farmerId);
              const city = msgBody.trim();
              await sendWhatsAppMessage(from, lang === 'hi' ? '🌤️ "' + city + '" ka mausam dhundh raha hoon...' : 'Looking up weather for "' + city + '"...');
              const weatherMsg = await getWeather(city);
              if (weatherMsg) {
                await sendWhatsAppMessage(from, weatherMsg);
                setPendingAction(farmerId, 'weather_city');
                await sendWhatsAppMessage(from, lang === 'hi' ? 'Kisi aur shehar ka mausam jaanne ke liye naam likhen, ya "menu" type karein.' : 'Type another city name, or type "menu".');
              } else {
                await sendWhatsAppMessage(from, lang === 'hi' ? '❌ "' + city + '" ka mausam nahi mil paya. Kripya sahi shehar naam likhen.' : 'Could not find weather for "' + city + '".');
                setPendingAction(farmerId, 'weather_city');
              }
              await pool.query(
                "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
                [sessionId, farmerId, '[weather: ' + city + ']']
              );
              continue;
            }

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

                    // 8.5 CHECK AI CHAT MODE
          if (!isAiChatActive(farmerId)) {
            // Not in AI mode — show menu instead of calling AI
            await sendWhatsAppMessage(from, (farmerData.language || 'hi') === 'hi'
              ? '🙏 Kripya neeche diye menu mein se chunein, ya "AI se baat karein" select karein:'
              : 'Please select from the menu below, or choose "Chat with AI":');
            await sendMenuMessage(from, botConfig, farmerData.language || 'hi');
            await pool.query(
              "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
              [sessionId, farmerId, '[menu shown - AI mode inactive]']
            );
            continue;
          }

          // 8.6 RATE LIMIT CHECK (before AI call)
          const rateLimitResult = await checkRateLimits(farmerId, farmerData.language || 'hi');

          if (rateLimitResult.blocked) {
            console.log('Rate limited:', farmerId, rateLimitResult.reason);
            await sendWhatsAppMessage(from, rateLimitResult.message);
            await pool.query(
              "INSERT INTO wa_messages (id, session_id, farmer_id, direction, sender_type, message_type, content, wa_status, created_at) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'text', $3, 'sent', NOW())",
              [sessionId, farmerId, '[rate limited: ' + rateLimitResult.reason + ']']
            );
            continue;
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


};
