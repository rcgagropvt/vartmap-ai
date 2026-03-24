import pg from "pg";
const { Pool } = pg;
import { config } from "../config.js";

export const db = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});
