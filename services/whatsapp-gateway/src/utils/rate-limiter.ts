import { redisClient } from "./redis.js";
import { config } from "../config.js";

/**
 * Per-farmer sliding-window rate limiter.
 * Returns { allowed: boolean, remaining: number, resetInSeconds: number }
 */
export async function checkFarmerRateLimit(farmerId: string): Promise<{
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
}> {
  const minuteKey = `rl:farmer:min:${farmerId}`;
  const dailyKey = `rl:farmer:day:${farmerId}`;

  const pipe = redisClient.pipeline();
  pipe.incr(minuteKey);
  pipe.ttl(minuteKey);
  pipe.incr(dailyKey);
  pipe.ttl(dailyKey);

  const results = await pipe.exec();
  if (!results) return { allowed: false, remaining: 0, resetInSeconds: 60 };

  const [minuteCount, minuteTTL, dailyCount, dailyTTL] = results.map(
    (r) => (r ? (r[1] as number) : 0)
  );

  // Set TTLs on first increment
  if (minuteCount === 1) await redisClient.expire(minuteKey, 60);
  if (dailyCount === 1) await redisClient.expire(dailyKey, 86400);

  const minuteExceeded = minuteCount > config.FARMER_RATE_LIMIT_PER_MINUTE;
  const dailyExceeded = dailyCount > config.FARMER_DAILY_LIMIT;

  return {
    allowed: !minuteExceeded && !dailyExceeded,
    remaining: Math.max(0, config.FARMER_DAILY_LIMIT - dailyCount),
    resetInSeconds: dailyExceeded ? (dailyTTL > 0 ? dailyTTL : 86400) : (minuteTTL > 0 ? minuteTTL : 60),
  };
}
