import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { verifyWebhookSignature } from "../utils/signature.js";
import { isDuplicate } from "../utils/dedup.js";
import { logger } from "../utils/logger.js";
import { processInboundMessage } from "../handlers/inbound.js";
import { processStatusUpdate } from "../handlers/status.js";

export async function webhookRoutes(app: FastifyInstance) {
  // ── Verification (GET) ────────────────────────────────────
  app.get("/", async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string>;
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (mode === "subscribe" && token === config.WA_WEBHOOK_VERIFY_TOKEN) {
      logger.info("Webhook verification successful");
      return reply.status(200).send(challenge);
    }
    logger.warn("Webhook verification failed");
    return reply.status(403).send("Forbidden");
  });

  // ── Inbound events (POST) ────────────────────────────────
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    }
  );

  app.post("/", async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = req.body as Buffer;

    // 1. Signature verification
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyWebhookSignature(rawBody, sig)) {
      logger.warn("Invalid webhook signature");
      return reply.status(401).send("Invalid signature");
    }

    // Always respond 200 quickly to Meta
    reply.status(200).send("EVENT_RECEIVED");

    // 2. Parse payload
    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      logger.error("Failed to parse webhook JSON");
      return;
    }

    // 3. Process each entry
    const entries = payload?.entry || [];
    for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        if (change.field !== "messages") continue;
        const value = change.value;

        // ── BSUID extraction ──────────────────────────────
        const contacts = value?.contacts || [];
        const bsuidMap = new Map<string, string>();
        for (const contact of contacts) {
          if (contact.wa_id && contact.bsuid) {
            bsuidMap.set(contact.wa_id, contact.bsuid);
          }
        }

        // ── Messages ──────────────────────────────────────
        const messages = value?.messages || [];
        for (const msg of messages) {
          // Dedup
          if (await isDuplicate(msg.id)) {
            logger.debug({ messageId: msg.id }, "Duplicate message, skipping");
            continue;
          }

          const bsuid = bsuidMap.get(msg.from) || null;
          await processInboundMessage(msg, bsuid, value.metadata);
        }

        // ── Statuses ──────────────────────────────────────
        const statuses = value?.statuses || [];
        for (const status of statuses) {
          await processStatusUpdate(status);
        }
      }
    }
  });
}
