import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sendMessage } from "../services/sender.js";
import { logger } from "../utils/logger.js";

const SendSchema = z.object({
  to: z.string().min(10),
  type: z.enum(["text", "template", "interactive", "image", "document", "audio", "video"]),
  body: z.any(),
  bsuid: z.string().optional(),
  farmer_id: z.string().uuid().optional(),
  idempotency_key: z.string().optional(),
});

const BatchSchema = z.object({
  messages: z.array(SendSchema).min(1).max(100),
});

export async function outboundRoutes(app: FastifyInstance) {
  // ── Single message ────────────────────────────────────────
  app.post("/send", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = SendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
        const data = parsed.data;
    try {
      const result = await sendMessage({
        to: data.to,
        type: data.type,
        body: data.body,
        bsuid: data.bsuid,
        farmerId: data.farmer_id,
        idempotencyKey: data.idempotency_key,
      });
      return reply.status(200).send(result);
    } catch (err: any) {
      logger.error({ err, to: data.to }, "Outbound send failed");
      return reply.status(502).send({
        error: "send_failed",
        message: err.message,
        wa_error: err.response?.data?.error || null,
      });
    }
  });

  // ── Batch send ────────────────────────────────────────────
  app.post("/send-batch", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const results = await Promise.allSettled(
      parsed.data.messages.map((msg) =>
        sendMessage({
          to: msg.to,
          type: msg.type,
          body: msg.body,
          bsuid: msg.bsuid,
          farmerId: msg.farmer_id,
          idempotencyKey: msg.idempotency_key,
        })
      )
    );

    const summary = results.map((r, i) => ({
      to: parsed.data.messages[i].to,
      status: r.status,
      result: r.status === "fulfilled" ? r.value : { error: (r as PromiseRejectedResult).reason?.message },
    }));

    return reply.status(200).send({
      total: summary.length,
      succeeded: summary.filter((s) => s.status === "fulfilled").length,
      failed: summary.filter((s) => s.status === "rejected").length,
      results: summary,
    });
  });

  // ── Send template ─────────────────────────────────────────
  app.post("/send-template", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as any;
    if (!body?.to || !body?.template_name) {
      return reply.status(400).send({ error: "to and template_name are required" });
    }

    try {
      const result = await sendMessage({
        to: body.to,
        type: "template",
        body: {
          name: body.template_name,
          language: { code: body.language || "hi" },
          components: body.components || [],
        },
        bsuid: body.bsuid,
        farmerId: body.farmer_id,
      });
      return reply.status(200).send(result);
    } catch (err: any) {
      logger.error({ err }, "Template send failed");
      return reply.status(502).send({ error: "template_send_failed", message: err.message });
    }
  });
}
