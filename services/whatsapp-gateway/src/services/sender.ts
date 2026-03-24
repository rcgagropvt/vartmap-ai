import axios, { AxiosInstance, AxiosError } from "axios";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { redisClient } from "../utils/redis.js";
import { db } from "../utils/db.js";

interface SendOptions {
  to: string;
  type: string;
  body: any;
  bsuid?: string | null;
  farmerId?: string;
  idempotencyKey?: string;
}

interface SendResult {
  message_id: string;
  to: string;
  timestamp: string;
}

const waApi: AxiosInstance = axios.create({
  baseURL: `https://graph.facebook.com/${config.WA_API_VERSION}/${config.WA_PHONE_NUMBER_ID}`,
  headers: {
    Authorization: `Bearer ${config.WA_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 30_000,
});

// ── Retry with exponential backoff ─────────────────────────
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = err?.response?.status;
      // Don't retry on 4xx client errors (except 429 rate limit)
      if (status && status >= 400 && status < 500 && status !== 429) throw err;

      const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      logger.warn({ attempt, delay, error: err.message }, "Retrying send");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ── Idempotency check ──────────────────────────────────────
async function checkIdempotency(key: string): Promise<SendResult | null> {
  const cached = await redisClient.get(`idem:${key}`);
  if (cached) return JSON.parse(cached);
  return null;
}

async function storeIdempotency(key: string, result: SendResult): Promise<void> {
  await redisClient.set(`idem:${key}`, JSON.stringify(result), "EX", 86400);
}

// ── Resolve recipient (phone vs BSUID) ────────────────────
async function resolveRecipient(to: string, bsuid?: string | null): Promise<string> {
  // Phase A/B: prefer phone number if available
  if (to && /^\d{10,15}$/.test(to)) return to;

  // If only BSUID provided, look up phone from DB
  if (bsuid) {
    const res = await db.query(
      `SELECT phone FROM farmers WHERE bsuid = $1 AND phone IS NOT NULL LIMIT 1`,
      [bsuid]
    );
    if (res.rows[0]?.phone) return res.rows[0].phone;
  }

  // Fallback: use whatever was provided (could be BSUID in Phase C)
  return bsuid || to;
}

// ── Build WhatsApp API payload ─────────────────────────────
function buildPayload(recipient: string, type: string, body: any): Record<string, any> {
  const base: Record<string, any> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type,
  };

  switch (type) {
    case "text":
      base.text = typeof body === "string" ? { body } : body;
      break;
    case "template":
      base.template = body;
      break;
    case "interactive":
      base.interactive = body;
      break;
    case "image":
      base.image = body;
      break;
    case "document":
      base.document = body;
      break;
    case "audio":
      base.audio = body;
      break;
    case "video":
      base.video = body;
      break;
    default:
      base.text = { body: JSON.stringify(body) };
  }

  return base;
}

// ── Main send function ─────────────────────────────────────
export async function sendMessage(options: SendOptions): Promise<SendResult> {
  const { to, type, body, bsuid, farmerId, idempotencyKey } = options;

  // Idempotency
  if (idempotencyKey) {
    const existing = await checkIdempotency(idempotencyKey);
    if (existing) {
      logger.debug({ idempotencyKey }, "Idempotent response returned from cache");
      return existing;
    }
  }

  const recipient = await resolveRecipient(to, bsuid);
  const payload = buildPayload(recipient, type, body);

  const response = await withRetry(async () => {
    const res = await waApi.post("/messages", payload);
    return res.data;
  });

  const result: SendResult = {
    message_id: response.messages?.[0]?.id || "unknown",
    to: recipient,
    timestamp: new Date().toISOString(),
  };

  // Store idempotency
  if (idempotencyKey) {
    await storeIdempotency(idempotencyKey, result);
  }

  // Update BSUID if we received one and farmer exists
  if (farmerId && bsuid) {
    await db.query(
      `UPDATE farmers SET bsuid = $1, updated_at = NOW() WHERE id = $2 AND (bsuid IS NULL OR bsuid != $1)`,
      [bsuid, farmerId]
    ).catch((err) => logger.warn({ err, farmerId }, "BSUID update failed (non-fatal)"));
  }

  // Track outbound in usage_tracking
  await db.query(
    `INSERT INTO usage_tracking (farmer_id, feature, channel, response_status, created_at)
     VALUES ($1, 'outbound_message', 'whatsapp', 'success', NOW())`,
    [farmerId || null]
  ).catch(() => {}); // best-effort

  logger.info({ messageId: result.message_id, to: recipient, type }, "Message sent");
  return result;
}
