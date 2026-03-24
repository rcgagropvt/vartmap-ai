import pg from "pg";
import { config } from "../config.js";
import { logger } from "./logger.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

db.on("error", (err) => {
  logger.error({ err }, "Unexpected PostgreSQL pool error");
});

db.on("connect", () => {
  logger.debug("New PostgreSQL client connected");
});
