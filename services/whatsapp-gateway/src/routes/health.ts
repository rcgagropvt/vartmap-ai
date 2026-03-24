import { FastifyInstance } from "fastify";
import { db } from "../utils/db.js";
import { redisClient } from "../utils/redis.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    const checks: Record<string, string> = {};

    // PostgreSQL
    try {
      await db.query("SELECT 1");
      checks.postgres = "ok";
    } catch {
      checks.postgres = "error";
    }

    // Redis
    try {
      await redisClient.ping();
      checks.redis = "ok";
    } catch {
      checks.redis = "error";
    }

    const healthy = Object.values(checks).every((v) => v === "ok");
    reply.status(healthy ? 200 : 503).send({
      status: healthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  app.get("/ready", async (_req, reply) => {
    reply.send({ status: "ready" });
  });
}
