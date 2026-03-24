import "dotenv/config";

export const config = {
  PORT: parseInt(process.env.PORT || "3001", 10),
  DATABASE_URL: process.env.DATABASE_URL || "",
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
  JWT_SECRET: process.env.JWT_SECRET || "change-me-in-production",
  JWT_EXPIRY: process.env.JWT_EXPIRY || "24h",
  CORS_ORIGINS: (process.env.CORS_ORIGINS || "*").split(","),
  WA_GATEWAY_URL: process.env.WA_GATEWAY_URL || "http://whatsapp-gateway:3000",
};
