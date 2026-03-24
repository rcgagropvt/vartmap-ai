# intelligence-service/src/limits/usage_limiter.py

from datetime import date


class UsageLimiter:
    """
    Enforces per-farmer daily usage limits by tier.
    Uses Redis counters for O(1) lookups.
    """

    TIER_LIMITS = {
        'free': {
            'text': 10,
            'image': 1,
            'voice': 3,
            'mandi': -1,  # unlimited
            'weather': -1,
            'soil': -1,
        },
        'premium': {
            'text': 50,
            'image': 5,
            'voice': 15,
            'mandi': -1,
            'weather': -1,
            'soil': -1,
        },
        'dealer_sponsored': {
            'text': 50,
            'image': 5,
            'voice': 15,
            'mandi': -1,
            'weather': -1,
            'soil': -1,
        }
    }

    def __init__(self, redis):
        self.redis = redis

    async def check(self, farmer_id: str, tier: str, query_type: str):
        """Check if farmer is within their daily limit."""
        limits = self.TIER_LIMITS.get(tier, self.TIER_LIMITS['free'])
        daily_limit = limits.get(query_type, 0)

        if daily_limit == -1:  # unlimited
            return UsageLimitResult(allowed=True)

        today = date.today().isoformat()
        key = f"usage:{farmer_id}:{today}:{query_type}"
        current = int(await self.redis.get(key) or 0)

        if current >= daily_limit:
            return UsageLimitResult(
                allowed=False,
                message=self._limit_message(query_type, tier, current, daily_limit)
            )

        # Soft warning at 80%
        warning = None
        if current >= daily_limit * 0.8:
            remaining = daily_limit - current
            warning = f"Aaj aapke {current}/{daily_limit} {query_type} ho gaye. {remaining} aur bache hain."

        return UsageLimitResult(allowed=True, warning=warning)

    async def increment(self, farmer_id: str, query_type: str):
        """Increment usage counter."""
        today = date.today().isoformat()
        key = f"usage:{farmer_id}:{today}:{query_type}"
        await self.redis.incr(key)
        await self.redis.expire(key, 86400)  # expire at end of day

    def _limit_message(self, query_type, tier, current, limit):
        if tier == 'free':
            return (
                f"Aaj ke {limit} {query_type} khatam ho gaye. "
                "Kal phir poochein! Ya Premium mein upgrade karein: ₹99/season mein unlimited sawal."
            )
        return f"Aaj ke {limit} {query_type} khatam ho gaye. Kal phir poochein."


class UsageLimitResult:
    def __init__(self, allowed: bool, message: str = None, warning: str = None):
        self.allowed = allowed
        self.message = message
        self.warning = warning
