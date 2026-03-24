"""
Tracks AI spend per farmer and globally. Enforces monthly budget.
"""

import json
from datetime import datetime
from src.config import settings
from src.utils.redis_client import redis_pool
from src.utils.db import db_pool
import structlog

log = structlog.get_logger()


async def track_ai_cost(
    farmer_id: str,
    feature: str,
    input_tokens: int,
    output_tokens: int,
    model: str,
) -> dict:
    """Record AI usage cost and return budget status."""
    cost_inr = (
        (input_tokens / 1000) * settings.AI_COST_PER_1K_INPUT
        + (output_tokens / 1000) * settings.AI_COST_PER_1K_OUTPUT
    )

    month_key = datetime.utcnow().strftime("%Y-%m")

    # Track in Redis for fast budget checks
    global_key = f"ai:cost:global:{month_key}"
    farmer_key = f"ai:cost:farmer:{farmer_id}:{month_key}"

    global_total = await redis_pool.client.incrbyfloat(global_key, cost_inr)
    farmer_total = await redis_pool.client.incrbyfloat(farmer_key, cost_inr)

    # Set TTL (45 days) on first write
    if global_total == cost_inr:
        await redis_pool.expire(global_key, 45 * 86400)
    if farmer_total == cost_inr:
        await redis_pool.expire(farmer_key, 45 * 86400)

    # Persist to DB
    await db_pool.execute(
        """INSERT INTO usage_tracking (farmer_id, feature, channel, tokens_used, cost_inr, response_status)
           VALUES ($1, $2, 'whatsapp', $3, $4, 'success')""",
        farmer_id, feature, input_tokens + output_tokens, cost_inr,
    )

    budget_remaining = settings.AI_MONTHLY_BUDGET_INR - float(global_total)
    budget_exceeded = budget_remaining <= 0

    if budget_exceeded:
        log.warn("AI monthly budget exceeded", global_total=global_total, budget=settings.AI_MONTHLY_BUDGET_INR)

    return {
        "cost_inr": round(cost_inr, 4),
        "farmer_month_total": round(float(farmer_total), 4),
        "global_month_total": round(float(global_total), 4),
        "budget_remaining": round(budget_remaining, 2),
        "budget_exceeded": budget_exceeded,
        "model": model,
    }


async def check_budget_available() -> bool:
    month_key = datetime.utcnow().strftime("%Y-%m")
    total = await redis_pool.get(f"ai:cost:global:{month_key}")
    if total is None:
        return True
    return float(total) < settings.AI_MONTHLY_BUDGET_INR


async def get_farmer_ai_usage_today(farmer_id: str) -> int:
    """Count AI queries used today."""
    count = await db_pool.fetchval(
        """SELECT COUNT(*) FROM usage_tracking
           WHERE farmer_id = $1 AND feature IN ('ai_query','image_analysis')
             AND created_at >= CURRENT_DATE""",
        farmer_id,
    )
    return count or 0
