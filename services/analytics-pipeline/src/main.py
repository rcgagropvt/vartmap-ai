"""
Analytics pipeline – scheduled data ingestion and materialized view refresh.
"""

import asyncio
import schedule
import time
from datetime import datetime

from src.ingestors.mandi_ingestor import ingest_mandi_prices
from src.ingestors.soil_ingestor import ingest_soil_data
from src.refresh import refresh_materialized_views
import structlog

log = structlog.get_logger()


async def run_daily_pipeline():
    log.info("Starting daily analytics pipeline", timestamp=datetime.utcnow().isoformat())

    try:
        await ingest_mandi_prices()
        log.info("Mandi price ingestion complete")
    except Exception as e:
        log.error("Mandi ingestion failed", error=str(e))

    try:
        await ingest_soil_data()
        log.info("Soil data ingestion complete")
    except Exception as e:
        log.error("Soil data ingestion failed", error=str(e))

    try:
        await refresh_materialized_views()
        log.info("Materialized views refreshed")
    except Exception as e:
        log.error("MV refresh failed", error=str(e))

    log.info("Daily pipeline complete")


def run_sync():
    asyncio.run(run_daily_pipeline())


if __name__ == "__main__":
    log.info("Analytics pipeline scheduler started")

    # Run immediately on startup
    run_sync()

    # Schedule daily at 5:30 AM IST (00:00 UTC)
    schedule.every().day.at("00:00").do(run_sync)

    # Also refresh MVs every 6 hours
    schedule.every(6).hours.do(lambda: asyncio.run(refresh_materialized_views()))

    while True:
        schedule.run_pending()
        time.sleep(60)
