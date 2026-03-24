import asyncpg
from temporalio import activity
from src.config import settings


async def _get_conn():
    return await asyncpg.connect(settings.DATABASE_URL)


@activity.defn
async def get_farmer(farmer_id: str) -> dict | None:
    conn = await _get_conn()
    try:
        row = await conn.fetchrow("SELECT * FROM farmers WHERE id = $1", farmer_id)
        return dict(row) if row else None
    finally:
        await conn.close()


@activity.defn
async def update_farmer_field(farmer_id: str, field: str, value: str) -> bool:
    allowed_fields = {"name", "state_code", "district", "village", "preferred_language", "land_acres"}
    if field not in allowed_fields:
        raise ValueError(f"Field {field} not allowed")
    conn = await _get_conn()
    try:
        await conn.execute(f"UPDATE farmers SET {field} = $1, updated_at = NOW() WHERE id = $2", value, farmer_id)
        return True
    finally:
        await conn.close()


@activity.defn
async def check_farmer_onboarded(farmer_id: str) -> bool:
    conn = await _get_conn()
    try:
        result = await conn.fetchval(
            "SELECT onboarding_complete FROM farmers WHERE id = $1", farmer_id
        )
        return bool(result)
    finally:
        await conn.close()


@activity.defn
async def delete_farmer_data(farmer_id: str) -> bool:
    """Delete farmer data after 30-day non-completion (GDPR compliance)."""
    conn = await _get_conn()
    try:
        await conn.execute("DELETE FROM farmers WHERE id = $1 AND onboarding_complete = FALSE", farmer_id)
        return True
    finally:
        await conn.close()
