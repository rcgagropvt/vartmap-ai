from fastapi import APIRouter, Query
from src.services.scheme_service import search_schemes

router = APIRouter()


@router.get("/search")
async def scheme_search(
    q: str = Query(..., description="Search query"),
    state: str | None = Query(None),
    language: str = Query("hi"),
):
    result = await search_schemes(q, state, language)
    return result
