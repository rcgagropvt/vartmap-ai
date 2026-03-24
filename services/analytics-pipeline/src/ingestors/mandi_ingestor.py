"""
Ingests mandi prices from Agmarknet and data.gov.in into mandi_prices table.
"""

import httpx
from bs4 import BeautifulSoup
import asyncpg
import os
import structlog

log = structlog.get_logger()
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://vartmap:vartmap@localhost:5432/vartmap")


async def ingest_mandi_prices():
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        # Fetch from data.gov.in API (more reliable than scraping)
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                "https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070",
                params={
                    "api-key": os.environ.get("DATA_GOV_API_KEY", ""),
                    "format": "json",
                    "limit": 5000,
                },
            )

            if resp.status_code != 200:
                log.warn("data.gov.in API returned non-200", status=resp.status_code)
                return

            data = resp.json()
            records = data.get("records", [])

        inserted = 0
        for record in records:
            try:
                await conn.execute(
                    """INSERT INTO mandi_prices
                         (state_code, district, market_name, crop_name,
                          variety, min_price, max_price, modal_price, arrival_date)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                       ON CONFLICT (market_name, crop_name, variety, arrival_date) DO UPDATE
                         SET min_price = EXCLUDED.min_price,
                             max_price = EXCLUDED.max_price,
                             modal_price = EXCLUDED.modal_price""",
                    record.get("state", ""),
                    record.get("district", ""),
                    record.get("market", ""),
                    record.get("commodity", ""),
                    record.get("variety", ""),
                    int(record.get("min_price", 0)),
                    int(record.get("max_price", 0)),
                    int(record.get("modal_price", 0)),
                    record.get("arrival_date", ""),
                )
                inserted += 1
            except Exception as e:
                log.debug("Record insert failed", error=str(e))

        log.info("Mandi prices ingested", total_records=len(records), inserted=inserted)

    finally:
        await conn.close()
