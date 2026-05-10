import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { farmerRoutes } from "./routes/farmers.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { moderationRoutes } from "./routes/moderation.js";
import { videoRoutes } from "./routes/videos.js";
import { db } from "./utils/db.js";

const app = Fastify({ logger: true, trustProxy: true });

async function bootstrap() {
  await app.register(helmet);
  await app.register(cors, { origin: config.CORS_ORIGINS });
  await app.register(jwt, { secret: config.JWT_SECRET });

  // Auth middleware decorator
  app.decorate("authenticate", async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.status(401).send({ error: "Unauthorized" });
    }
  });

  // Health check
  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { status: "healthy" };
  });

  // Routes
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(farmerRoutes, { prefix: "/api/v1/farmers" });
  await app.register(campaignRoutes, { prefix: "/api/v1/campaigns" });
  await app.register(analyticsRoutes, { prefix: "/api/v1/analytics" });
  await app.register(moderationRoutes, { prefix: "/api/v1/moderation" });
  await app.register(videoRoutes, { prefix: "/api/v1/videos" });

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

bootstrap().catch((err) => { console.error(err); process.exit(1); });
