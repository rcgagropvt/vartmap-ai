"""
Anti-spam detection layer.
"""

import re
from src.utils.redis_client import redis_pool
import structlog

log = structlog.get_logger()

SPAM_PATTERNS = [
    r"(?:click\s+here|अभी\s+क्लिक)",
    r"(?:win\s+prize|जीतें\s+इनाम)",
    r"(?:lottery|लॉटरी)",
    r"(?:http[s]?://(?!agmarknet|pmkisan|pmfby|enam|soilhealth))",
    r"(?:forex|crypto|bitcoin|बिटकॉइन)",
    r"(?:call\s+me\s+at|मुझे\s+कॉल\s+करें\s+\d{10})",
]

RAPID_FIRE_LIMIT = 10  # messages in 30 seconds
RAPID_FIRE_WINDOW = 30


async def check_spam(farmer_id: str, content: str) -> dict:
    """Returns {is_spam: bool, reason: str|None}."""

    # 1. Pattern-based check
    for pattern in SPAM_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE):
            return {"is_spam": True, "reason": f"pattern_match:{pattern[:30]}"}

    # 2. Rapid-fire detection
    key = f"spam:rapid:{farmer_id}"
    count = await redis_pool.incr(key)
    if count == 1:
        await redis_pool.expire(key, RAPID_FIRE_WINDOW)
    if count > RAPID_FIRE_LIMIT:
        return {"is_spam": True, "reason": "rapid_fire"}

    # 3. Repetition detection (same message sent 5+ times in 1 hour)
    import hashlib
    msg_hash = hashlib.md5(content.lower().strip().encode()).hexdigest()[:12]
    repeat_key = f"spam:repeat:{farmer_id}:{msg_hash}"
    repeat_count = await redis_pool.incr(repeat_key)
    if repeat_count == 1:
        await redis_pool.expire(repeat_key, 3600)
    if repeat_count > 5:
        return {"is_spam": True, "reason": "repetition"}

    return {"is_spam": False, "reason": None}
