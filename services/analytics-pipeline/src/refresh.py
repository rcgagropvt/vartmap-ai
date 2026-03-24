import asyncpg
import os
import structlog

log = structlog.get_logger()
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://vartmap:vartmap@localhost:5432/vartmap")


async def refresh_materialized_views():
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        views = [
            "mv_usage_daily",
        ]
        for view in views:
            try:
                await conn.execute(f"REFRESH MATERIALIZED VIEW CONCURRENTLY {view}")
                log.info("Refreshed MV", view=view)
            except Exception as e:
                log.warn("MV refresh failed", view=view, error=str(e))
                # Try non-concurrent refresh
                try:
                    await conn.execute(f"REFRESH MATERIALIZED VIEW {view}")
                    log.info("Refreshed MV (non-concurrent)", view=view)
                except Exception as e2:
                    log.error("MV refresh failed completely", view=view, error=str(e2))
    finally:
        await conn.close()
