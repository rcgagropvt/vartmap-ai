"""
Weather service – fetches from OpenWeatherMap and generates agricultural advisory.
"""

import httpx
from src.config import settings
from src.utils.redis_client import redis_pool
from src.utils.db import db_pool
import json
import structlog

log = structlog.get_logger()

# District → approximate lat/lon (loaded from DB at runtime)
_district_coords_cache: dict = {}


async def get_district_coords(district: str, state: str | None) -> tuple[float, float]:
    if district in _district_coords_cache:
        return _district_coords_cache[district]

    row = await db_pool.fetchrow(
        "SELECT latitude, longitude FROM districts WHERE LOWER(district_name) = LOWER($1) LIMIT 1",
        district,
    )
    if row:
        coords = (row["latitude"], row["longitude"])
        _district_coords_cache[district] = coords
        return coords

    # Fallback: Delhi
    return (28.6139, 77.2090)


async def get_weather(district: str | None, state: str | None) -> dict:
    if not district:
        district = "New Delhi"

    # Redis cache (30 min TTL)
    cache_key = f"weather:{district}"
    cached = await redis_pool.get(cache_key)
    if cached:
        return json.loads(cached)

    lat, lon = await get_district_coords(district, state)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Current weather
            resp = await client.get(
                f"{settings.OPENWEATHER_BASE_URL}/onecall",
                params={
                    "lat": lat, "lon": lon,
                    "appid": settings.OPENWEATHER_API_KEY,
                    "units": "metric",
                    "lang": "hi",
                    "exclude": "minutely",
                },
            )
            data = resp.json()

        current = data.get("current", {})
        daily = data.get("daily", [{}])[0]

        weather = {
            "temp": round(current.get("temp", 0)),
            "feels_like": round(current.get("feels_like", 0)),
            "humidity": current.get("humidity", 0),
            "wind_speed": round(current.get("wind_speed", 0) * 3.6, 1),  # m/s → km/h
            "uvi": current.get("uvi", 0),
            "rain_chance": round(daily.get("pop", 0) * 100),
            "rain_mm": daily.get("rain", 0),
            "description": current.get("weather", [{}])[0].get("description", ""),
            "advisory_hi": generate_advisory_hi(current, daily),
            "advisory_en": generate_advisory_en(current, daily),
        }

        await redis_pool.set(cache_key, json.dumps(weather), ex=1800)
        return weather

    except Exception as e:
        log.error("Weather API failed", error=str(e), district=district)
        return {
            "temp": 0, "humidity": 0, "wind_speed": 0, "rain_chance": 0,
            "advisory_hi": "मौसम जानकारी अभी उपलब्ध नहीं है।",
            "advisory_en": "Weather information currently unavailable.",
        }


def generate_advisory_hi(current: dict, daily: dict) -> str:
    advisories = []
    rain_chance = daily.get("pop", 0)
    temp = current.get("temp", 25)
    humidity = current.get("humidity", 50)
    wind = current.get("wind_speed", 0) * 3.6

    if rain_chance > 0.7:
        advisories.append("भारी बारिश की संभावना — छिड़काव न करें, फसल सुरक्षा का ध्यान रखें।")
    elif rain_chance > 0.4:
        advisories.append("बारिश हो सकती है — सिंचाई टालें और स्प्रे सुबह जल्दी करें।")

    if temp > 40:
        advisories.append("अत्यधिक गर्मी — सुबह-शाम ही खेत में काम करें, पशुओं को छाया में रखें।")
    elif temp < 5:
        advisories.append("पाला पड़ने की संभावना — फसल को ढकें, हल्की सिंचाई करें।")

    if humidity > 85:
        advisories.append("उच्च नमी — फफूंद रोग की संभावना, फसल की निगरानी करें।")

    if wind > 40:
        advisories.append("तेज़ हवा — स्प्रे न करें, बाड़ और सहारे की जांच करें।")

    return " ".join(advisories) if advisories else "खेती के लिए अनुकूल मौसम।"


def generate_advisory_en(current: dict, daily: dict) -> str:
    advisories = []
    rain_chance = daily.get("pop", 0)
    temp = current.get("temp", 25)
    humidity = current.get("humidity", 50)
    wind = current.get("wind_speed", 0) * 3.6

    if rain_chance > 0.7:
        advisories.append("Heavy rain likely — avoid spraying, protect harvested produce.")
    elif rain_chance > 0.4:
        advisories.append("Rain possible — postpone irrigation, spray early morning.")

    if temp > 40:
        advisories.append("Extreme heat — work in fields during cooler hours, keep livestock in shade.")
    elif temp < 5:
        advisories.append("Frost risk — cover crops, apply light irrigation.")

    if humidity > 85:
        advisories.append("High humidity — monitor for fungal diseases.")

    if wind > 40:
        advisories.append("Strong winds — avoid spraying, check supports and fences.")

    return " ".join(advisories) if advisories else "Favourable weather for farming."
