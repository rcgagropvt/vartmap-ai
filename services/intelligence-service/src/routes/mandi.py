from fastapi import APIRouter, Query
from src.services.mandi_service import get_mandi_prices

router = APIRouter()


@router.get("/prices")
async def mandi_prices(
    crop: str = Query(..., description="Crop name"),
    state: str | None = Query(None),
    district: str | None = Query(None),
):
    prices = await get_mandi_prices(crop, state, district)
    return {"crop": crop, "count": len(prices), "prices": prices}
