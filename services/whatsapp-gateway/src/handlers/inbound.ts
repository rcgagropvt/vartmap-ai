import { logger } from "../utils/logger.js";
import { db } from "../utils/db.js";
import { redisClient } from "../utils/redis.js";
import { checkFarmerRateLimit } from "../utils/rate-limiter.js";
import { config } from "../config.js";
import axios from "axios";

interface WAMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  audio?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string; filename: string };
  location?: { latitude: number; longitude: number };
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  button?: { text: string; payload: string };
  context?: { message_id: string };
}

interface WAMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

export async function processInboundMessage(
  msg: WAMessage,
  bsuid: string | null,
  metadata: WAMetadata
): Promise<void> {
  const phone = msg.from;
  const messageId = msg.id;

  try {
    // 1. Find or register farmer
    let farmer = await findFarmerByPhone(phone);
    if (!farmer) {
      farmer = await registerNewFarmer(phone, bsuid);
      // Trigger onboarding flow
      await triggerOnboarding(farmer.id, phone);
      return;
    }

    // Update BSUID if new
    if (bsuid && farmer.bsuid !== bsuid) {
      await db.query(`UPDATE farmers SET bsuid = $1, updated_at = NOW() WHERE id = $2`, [bsuid, farmer.id]);
      farmer.bsuid = bsuid;
    }

    // 2. Rate limiting
    const rateCheck = await checkFarmerRateLimit(farmer.id);
    if (!rateCheck.allowed) {
      logger.warn({ farmerId: farmer.id }, "Farmer rate limited");
      await sendRateLimitNotice(phone, farmer.preferred_language);
      return;
    }

    // 3. Check moderation status
    const isMuted = await checkModerationStatus(farmer.id);
    if (isMuted) {
      logger.info({ farmerId: farmer.id }, "Muted farmer message ignored");
      return;
    }

    // 4. Store conversation record
    const conversationId = await storeConversation(farmer.id, msg);

    // 5. Extract message content
    const content = extractContent(msg);

    // 6. Forward to intelligence service
    await forwardToIntelligence({
      farmerId: farmer.id,
      phone,
      bsuid: farmer.bsuid,
      conversationId,
      messageId,
      messageType: msg.type,
      content,
      language: farmer.preferred_language,
      state: farmer.state_code,
      district: farmer.district,
      crops: farmer.crops || [],
      onboardingComplete: farmer.onboarding_complete,
      context: msg.context || null,
      timestamp: msg.timestamp,
    });

  } catch (err) {
    logger.error({ err, messageId, phone }, "Failed to process inbound message");
    // Store for retry
    await redisClient.lpush("wa:failed_inbound", JSON.stringify({
      msg, bsuid, metadata, error: (err as Error).message, timestamp: Date.now(),
    }));
  }
}

// ── Helpers ────────────────────────────────────────────────

async function findFarmerByPhone(phone: string) {
  const res = await db.query(
    `SELECT id, phone, bsuid, name, preferred_language, state_code, district,
            onboarding_complete, tier, crops
     FROM farmers WHERE phone = $1 LIMIT 1`,
    [phone]
  );
  return res.rows[0] || null;
}

async function registerNewFarmer(phone: string, bsuid: string | null) {
  const res = await db.query(
    `INSERT INTO farmers (phone, bsuid, preferred_language, onboarding_complete)
     VALUES ($1, $2, 'hi', FALSE)
     RETURNING id, phone, bsuid, preferred_language, onboarding_complete`,
    [phone, bsuid]
  );
  logger.info({ phone, farmerId: res.rows[0].id }, "New farmer registered");
  return res.rows[0];
}

async function triggerOnboarding(farmerId: string, phone: string) {
  try {
    await axios.post(`${config.AUTOMATION_SERVICE_URL}/api/v1/workflows/onboarding`, {
      farmer_id: farmerId,
      phone,
    }, { timeout: 5000 });
  } catch (err) {
    logger.error({ err, farmerId }, "Failed to trigger onboarding workflow");
  }
}

async function sendRateLimitNotice(phone: string, language: string) {
  const messages: Record<string, string> = {
    hi: "🙏 आप बहुत तेज़ी से संदेश भेज रहे हैं। कृपया कुछ देर बाद प्रयास करें।",
    en: "You're sending messages too quickly. Please try again shortly.",
  };
  const { sendMessage } = await import("../services/sender.js");
  await sendMessage({
    to: phone,
    type: "text",
    body: messages[language] || messages.hi,
  });
}

async function checkModerationStatus(farmerId: string): Promise<boolean> {
  const res = await db.query(
    `SELECT is_muted, is_banned, muted_until, banned_until
     FROM farmer_moderation_status WHERE farmer_id = $1`,
    [farmerId]
  );
  if (!res.rows[0]) return false;
  const { is_muted, is_banned, muted_until, banned_until } = res.rows[0];
  const now = new Date();
  if (is_banned && (!banned_until || new Date(banned_until) > now)) return true;
  if (is_muted && (!muted_until || new Date(muted_until) > now)) return true;
  return false;
}

async function storeConversation(farmerId: string, msg: WAMessage): Promise<string> {
  const res = await db.query(
    `INSERT INTO conversations (farmer_id, wa_message_id, direction, message_type, raw_payload, created_at)
     VALUES ($1, $2, 'inbound', $3, $4, NOW())
     RETURNING id`,
    [farmerId, msg.id, msg.type, JSON.stringify(msg)]
  );
  return res.rows[0].id;
}

function extractContent(msg: WAMessage): string {
  switch (msg.type) {
    case "text": return msg.text?.body || "";
    case "interactive":
      return msg.interactive?.button_reply?.title
        || msg.interactive?.list_reply?.title
        || "";
    case "button": return msg.button?.text || msg.button?.payload || "";
    case "image": return msg.image?.caption || "[image]";
    case "audio": return "[audio]";
    case "document": return `[document: ${msg.document?.filename}]`;
    case "location": return `[location: ${msg.location?.latitude},${msg.location?.longitude}]`;
    default: return `[${msg.type}]`;
  }
}

async function forwardToIntelligence(payload: Record<string, any>) {
  try {
    await axios.post(`${config.INTELLIGENCE_SERVICE_URL}/api/v1/process`, payload, {
      timeout: 25_000,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.error({ err, farmerId: payload.farmerId }, "Intelligence service forwarding failed");
    // Queue for retry
    await redisClient.lpush("wa:intelligence_retry", JSON.stringify(payload));
  }
}
