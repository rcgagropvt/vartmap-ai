from fastapi import APIRouter, Query
from src.utils.db import db_pool
from src.utils.cost_tracker import check_budget_available

router = APIRouter()


@router.get("/stats")
async def admin_stats():
    """Quick system stats for admin dashboard."""
    total_farmers = await db_pool.fetchval("SELECT COUNT(*) FROM farmers")
    active_today = await db_pool.fetchval(
        "SELECT COUNT(DISTINCT farmer_id) FROM usage_tracking WHERE created_at >= CURRENT_DATE"
    )
    total_conversations = await db_pool.fetchval("SELECT COUNT(*) FROM conversations WHERE created_at >= CURRENT_DATE")
    budget_ok = await check_budget_available()

    return {
        "total_farmers": total_farmers,
        "active_today": active_today,
        "conversations_today": total_conversations,
        "ai_budget_available": budget_ok,
    }


@router.get("/usage")
async def usage_report(days: int = Query(7, ge=1, le=90)):
    rows = await db_pool.fetch(
        """SELECT date_trunc('day', created_at)::date AS day,
                  feature, COUNT(*) AS count,
                  SUM(cost_inr) AS total_cost,
                  AVG(latency_ms)::int AS avg_latency
           FROM usage_tracking
           WHERE created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
           GROUP BY 1, 2
           ORDER BY 1 DESC, 3 DESC""",
        days,
    )
    return {"days": days, "usage": [dict(r) for r in rows]}
