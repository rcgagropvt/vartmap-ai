# intelligence-service/src/limits/anti_spam.py

import time


class AntiSpamSystem:
    """
    Multi-layered spam detection and rate limiting.
    Protects against message floods, duplicate spam, and abuse.
    """

    def __init__(self, redis, db):
        self.redis = redis
        self.db = db

    async def check(self, farmer: dict):
        farmer_id = farmer['id']

        # Check if currently blocked
        blocked_until = farmer.get('blocked_until')
        if blocked_until and blocked_until > time.time():
            remaining = int((blocked_until - time.time()) / 60)
            return SpamCheckResult(
                is_blocked=True,
                message=f"Aapka account {remaining} minute ke liye restricted hai."
            )

        # Rate check: messages per minute
        minute_key = f"ratelimit:{farmer_id}:minute"
        minute_count = int(await self.redis.get(minute_key) or 0)
        await self.redis.incr(minute_key)
        await self.redis.expire(minute_key, 60)

        if minute_count > 10:
            # Level 1: Flood detected
            hour_key = f"ratelimit:{farmer_id}:hour"
            hour_count = int(await self.redis.get(hour_key) or 0)

            if hour_count > 50:
                # Level 2: Sustained flooding
                spam_level = farmer.get('spam_level', 0)
                if spam_level >= 2:
                    # Level 3: Repeated offender
                    await self._block_farmer(farmer_id, hours=24)
                    return SpamCheckResult(
                        is_blocked=True,
                        message="Aapka account temporarily restricted hai. 24 ghante baad try karein."
                    )
                else:
                    await self._block_farmer(farmer_id, minutes=15)
                    await self._increment_spam_level(farmer_id)
                    return SpamCheckResult(
                        is_blocked=True,
                        message="Aapke messages bahut zyada ho rahe hain. 15 minute baad try karein."
                    )
            else:
                return SpamCheckResult(
                    is_blocked=False,
                    message="Dhire-dhire poochiye, hum yahan hain!"
                )

        # Rate check: messages per hour
        hour_key = f"ratelimit:{farmer_id}:hour"
        await self.redis.incr(hour_key)
        await self.redis.expire(hour_key, 3600)

        return SpamCheckResult(is_blocked=False)

    async def _block_farmer(self, farmer_id, hours=0, minutes=0):
        block_duration = hours * 3600 + minutes * 60
        blocked_until = time.time() + block_duration
        await self.db.execute(
            "UPDATE farmers SET blocked_until = to_timestamp($1) WHERE id = $2",
            blocked_until, farmer_id
        )

    async def _increment_spam_level(self, farmer_id):
        await self.db.execute(
            "UPDATE farmers SET spam_level = spam_level + 1 WHERE id = $1",
            farmer_id
        )


class SpamCheckResult:
    def __init__(self, is_blocked: bool, message: str = None):
        self.is_blocked = is_blocked
        self.message = message
