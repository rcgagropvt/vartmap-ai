"""
Mandi (market) price service – fetches from DB cache or Agmarknet.
"""

import httpx
from datetime import date, timedelta
from bs4 import BeautifulSoup

from src.utils.db import db_pool
from src.utils.redis_client import redis_pool
from src.config import settings
import structlog

log = structlog.get_logger()


async def get_mandi_prices(
    crop_query: str,
    state: str | None = None,
    district: str | None = None,
    farmer_crops: list[str] | None = None,
) -> list[dict]:
    """Get latest mandi prices, preferring DB cache, falling back to Agmarknet scrape."""

    # Extract crop name from query
    crop = extract_crop_name(crop_query, farmer_crops)

    # 1. Try DB cache (updated by daily ingestion pipeline)
    prices = await fetch_from_db(crop, state, district)
    if prices:
        return prices

    # 2. Try Redis cache
    cache_key = f"mandi:{crop}:{state}:{district}"
    cached = await redis_pool.get(cache_key)
    if cached:
        import json
        return json.loads(cached)

    # 3. Scrape Agmarknet (fallback)
    prices = await scrape_agmarknet(crop, state, district)
    if prices:
        import json
        await redis_pool.set(cache_key, json.dumps(prices), ex=3600)

    return prices


def extract_crop_name(query: str, farmer_crops: list[str] | None) -> str:
    """Extract the crop name from user query."""
    import re

    crop_aliases = {
        "wheat": ["गेहूँ", "gehu", "gehun", "wheat"],
        "rice": ["धान", "chawal", "चावल", "dhan", "rice", "paddy"],
        "mustard": ["सरसों", "sarson", "mustard", "rai"],
        "potato": ["आलू", "aloo", "aalu", "potato"],
        "onion": ["प्याज", "pyaz", "pyaaz", "onion"],
        "tomato": ["टमाटर", "tamatar", "tomato"],
        "sugarcane": ["गन्ना", "ganna", "sugarcane"],
        "cotton": ["कपास", "kapas", "cotton"],
        "soybean": ["सोयाबीन", "soybean", "soya"],
        "chickpea": ["चना", "chana", "gram", "chickpea"],
        "maize": ["मक्का", "makka", "maize", "corn"],
    }

    query_lower = query.lower()
    for canonical, aliases in crop_aliases.items():
        for alias in aliases:
            if alias.lower() in query_lower:
                return canonical

    # If no crop found in query, use farmer's first crop
    if farmer_crops:
        return farmer_crops[0]

    return "wheat"  # default


async def fetch_from_db(crop: str, state: str | None, district: str | None) -> list[dict]:
    """Fetch from mandi_prices table (populated by ingestion pipeline)."""
    try:
        query = """
            SELECT crop_name AS crop, market_name AS market,
                   min_price, max_price, modal_price,
                   arrival_date, state_code
            FROM mandi_prices
            WHERE LOWER(crop_name) = LOWER($1)
              AND arrival_date >= CURRENT_DATE - INTERVAL '2 days'
        """
        params = [crop]
        idx = 2

        if state:
            query += f" AND state_code = ${idx}"
            params.append(state)
            idx += 1
        if district:
            query += f" AND LOWER(district) = LOWER(${idx})"
            params.append(district)
            idx += 1

        query += " ORDER BY arrival_date DESC, modal_price DESC LIMIT 10"

        rows = await db_pool.fetch(query, *params)
        return [dict(r) for r in rows]
    except Exception as e:
        log.warn("DB mandi fetch failed", error=str(e))
        return []


async def scrape_agmarknet(crop: str, state: str | None, district: str | None) -> list[dict]:
    """Scrape Agmarknet as a fallback for latest prices."""
    try:
        url = f"{settings.AGMARKNET_BASE_URL}/SearchCmmMkt.aspx"
        params = {
            "Ession_CommodityName": crop,
            "Ession_StateName": state or "",
        }

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params=params)

        if resp.status_code != 200:
            return []

        soup = BeautifulSoup(resp.text, "html.parser")
        table = soup.find("table", {"id": "cphBody_GridViewPriceData"})
        if not table:
            return []

        prices = []
        rows = table.find_all("tr")[1:]  # skip header
        for row in rows[:10]:
            cols = row.find_all("td")
            if len(cols) >= 7:
                prices.append({
                    "crop": cols[2].get_text(strip=True),
                    "market": cols[1].get_text(strip=True),
                    "min_price": cols[4].get_text(strip=True),
                    "max_price": cols[5].get_text(strip=True),
                    "modal_price": cols[6].get_text(strip=True),
                })
        return prices

    except Exception as e:
        log.warn("Agmarknet scrape failed", error=str(e))
        return []
