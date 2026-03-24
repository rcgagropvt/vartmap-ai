import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { webhookRoutes } from "./routes/webhook.js";
import { healthRoutes } from "./routes/health.js";
import { outboundRoutes } from "./routes/outbound.js";
import { redisClient } from "./utils/redis.js";
import { db } from "./utils/db.js";

const app = Fastify({
  logger: logger,
  trustProxy: true,
  requestTimeout: 30_000,
  bodyLimit: 5 * 1024 * 1024, // 5 MB for media webhooks
});

async function bootstrap() {
  // ── Plugins ─────────────────────────────────────────────
  await app.register(helmet);
  await app.register(cors, { origin: config.CORS_ORIGINS });
  await app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
    redis: redisClient,
  });

  // ── Routes ──────────────────────────────────────────────
  await app.register(healthRoutes, { prefix: "/" });
  await app.register(webhookRoutes, { prefix: "/webhook" });
  await app.register(outboundRoutes, { prefix: "/api/v1/messages" });

  // ── Graceful shutdown ───────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully…`);
    await app.close();
    await redisClient.quit();
    await db.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ── Start ───────────────────────────────────────────────
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info(`WhatsApp Gateway listening on port ${config.PORT}`);
}

bootstrap().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

export { app };
