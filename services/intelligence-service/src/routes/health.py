from fastapi import APIRouter
from src.utils.db import db_pool
from src.utils.redis_client import redis_pool

router = APIRouter()


@router.get("/health")
async def health():
    checks = {}
    try:
        await db_pool.fetchval("SELECT 1")
        checks["postgres"] = "ok"
    except Exception:
        checks["postgres"] = "error"

    try:
        await redis_pool.client.ping()
        checks["redis"] = "ok"
    except Exception:
        checks["redis"] = "error"

    healthy = all(v == "ok" for v in checks.values())
    return {"status": "healthy" if healthy else "degraded", "checks": checks}


@router.get("/ready")
async def ready():
    return {"status": "ready"}
