import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  NODE_ENV: process.env.NODE_ENV || "development",

  // WhatsApp Business API
  WA_API_VERSION: process.env.WA_API_VERSION || "v21.0",
  WA_PHONE_NUMBER_ID: required("WA_PHONE_NUMBER_ID"),
  WA_BUSINESS_ACCOUNT_ID: required("WA_BUSINESS_ACCOUNT_ID"),
  WA_ACCESS_TOKEN: required("WA_ACCESS_TOKEN"),
  WA_WEBHOOK_VERIFY_TOKEN: required("WA_WEBHOOK_VERIFY_TOKEN"),
  WA_APP_SECRET: required("WA_APP_SECRET"),

  // Database
  DATABASE_URL: required("DATABASE_URL"),

  // Redis
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",

  // Internal services
  INTELLIGENCE_SERVICE_URL: process.env.INTELLIGENCE_SERVICE_URL || "http://intelligence-service:8000",
  AUTOMATION_SERVICE_URL: process.env.AUTOMATION_SERVICE_URL || "http://automation-worker:8001",

  // Rate limits
  FARMER_RATE_LIMIT_PER_MINUTE: parseInt(process.env.FARMER_RATE_LIMIT_PER_MINUTE || "30", 10),
  FARMER_DAILY_LIMIT: parseInt(process.env.FARMER_DAILY_LIMIT || "200", 10),

  // BSUID
  BSUID_ENABLED: process.env.BSUID_ENABLED === "true",

  CORS_ORIGINS: (process.env.CORS_ORIGINS || "").split(",").filter(Boolean),
} as const;
