from fastapi import APIRouter, Query
from src.services.weather_service import get_weather

router = APIRouter()


@router.get("/forecast")
async def weather_forecast(
    district: str = Query(...),
    state: str | None = Query(None),
):
    weather = await get_weather(district, state)
    return weather
