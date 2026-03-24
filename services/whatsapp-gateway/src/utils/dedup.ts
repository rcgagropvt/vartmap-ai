import { redisClient } from "./redis.js";

const DEDUP_TTL_SECONDS = 86400; // 24 hours
const PREFIX = "wa:dedup:";

/**
 * Returns true if this message ID has already been processed.
 * Uses Redis SETNX for atomic dedup.
 */
export async function isDuplicate(messageId: string): Promise<boolean> {
  const key = `${PREFIX}${messageId}`;
  const result = await redisClient.set(key, "1", "EX", DEDUP_TTL_SECONDS, "NX");
  return result === null; // null means key already existed
}
