"""
Government scheme search service.
"""

from src.utils.db import db_pool
import structlog

log = structlog.get_logger()


async def search_schemes(query: str, state: str | None, language: str) -> dict:
    """Search for government schemes matching the farmer's query."""

    # Use trigram similarity search
    rows = await db_pool.fetch(
        """SELECT name, name_hi, scheme_type, benefit_summary, eligibility, url, helpline
           FROM government_schemes
           WHERE is_active = TRUE
             AND (
                 name % $1 OR name_hi % $1
                 OR benefit_summary ILIKE '%' || $1 || '%'
                 OR eligibility ILIKE '%' || $1 || '%'
             )
           ORDER BY similarity(name, $1) DESC
           LIMIT 5""",
        query,
    )

    if not rows:
        # Fallback: return top 5 active schemes
        rows = await db_pool.fetch(
            "SELECT name, name_hi, scheme_type, benefit_summary, eligibility, url, helpline FROM government_schemes WHERE is_active = TRUE ORDER BY name LIMIT 5"
        )

    if language == "hi":
        text = "🏛 *सरकारी योजनाएं:*\n\n"
        for r in rows:
            text += f"📋 *{r['name_hi'] or r['name']}*\n"
            text += f"   लाभ: {r['benefit_summary']}\n"
            text += f"   पात्रता: {r['eligibility']}\n"
            if r['helpline']:
                text += f"   हेल्पलाइन: {r['helpline']}\n"
            if r['url']:
                text += f"   वेबसाइट: {r['url']}\n"
            text += "\n"
    else:
        text = "🏛 *Government Schemes:*\n\n"
        for r in rows:
            text += f"📋 *{r['name']}*\n"
            text += f"   Benefit: {r['benefit_summary']}\n"
            text += f"   Eligibility: {r['eligibility']}\n"
            if r['helpline']:
                text += f"   Helpline: {r['helpline']}\n"
            if r['url']:
                text += f"   Website: {r['url']}\n"
            text += "\n"

    return {"text": text, "count": len(rows)}
