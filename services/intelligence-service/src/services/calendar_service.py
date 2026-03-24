"""
Crop calendar service – returns current stage and upcoming activities.
"""

from datetime import date, timedelta
from src.utils.db import db_pool
import structlog

log = structlog.get_logger()


async def get_crop_calendar(
    farmer_id: str, crops: list[str], state: str | None, language: str
) -> dict:
    """Get crop calendar for the farmer's active crops."""

    # Check farmer-specific calendar first
    farmer_calendars = await db_pool.fetch(
        """SELECT fcc.crop_name, fcc.season, fcc.current_stage, fcc.sowing_date,
                  fcc.expected_harvest, fcc.stages_log, cct.stages AS template_stages
           FROM farmer_crop_calendar fcc
           LEFT JOIN crop_calendar_templates cct ON fcc.template_id = cct.id
           WHERE fcc.farmer_id = $1 AND fcc.status = 'active'
           ORDER BY fcc.created_at DESC""",
        farmer_id,
    )

    if farmer_calendars:
        return format_farmer_calendar(farmer_calendars, language)

    # Fallback: show template calendar for their crops
    if not crops:
        crops = ["wheat"]

    templates = await db_pool.fetch(
        """SELECT crop_name, variety, season, stages, total_duration_days, source
           FROM crop_calendar_templates
           WHERE LOWER(crop_name) = ANY(SELECT LOWER(unnest($1::text[])))
             AND ($2::text IS NULL OR state_code = $2 OR state_code IS NULL)
             AND is_active = TRUE
           ORDER BY crop_name""",
        crops, state,
    )

    return format_template_calendar(templates, language)


def format_farmer_calendar(calendars: list, language: str) -> dict:
    if language == "hi":
        text = "📅 *आपका फसल कैलेंडर:*\n\n"
        for cal in calendars:
            text += f"🌾 *{cal['crop_name']}* ({cal['season']})\n"
            text += f"   वर्तमान अवस्था: {cal['current_stage'] or 'अज्ञात'}\n"
            if cal['sowing_date']:
                text += f"   बुवाई: {cal['sowing_date']}\n"
            if cal['expected_harvest']:
                text += f"   अनुमानित कटाई: {cal['expected_harvest']}\n"
            text += "\n"
    else:
        text = "📅 *Your Crop Calendar:*\n\n"
        for cal in calendars:
            text += f"🌾 *{cal['crop_name']}* ({cal['season']})\n"
            text += f"   Current stage: {cal['current_stage'] or 'Unknown'}\n"
            if cal['sowing_date']:
                text += f"   Sowing: {cal['sowing_date']}\n"
            if cal['expected_harvest']:
                text += f"   Expected harvest: {cal['expected_harvest']}\n"
            text += "\n"
    return {"text": text}


def format_template_calendar(templates: list, language: str) -> dict:
    import json

    if language == "hi":
        text = "📅 *फसल कैलेंडर (सामान्य):*\n\n"
        for t in templates:
            text += f"🌾 *{t['crop_name']}* ({t['season']}) – {t['total_duration_days'] or '?'} दिन\n"
            stages = t['stages'] if isinstance(t['stages'], list) else json.loads(t['stages'])
            for s in stages[:4]:
                text += f"   ▸ {s.get('stage', '')}: {s.get('advisory', '')[:60]}…\n"
            text += f"   (स्रोत: {t.get('source', 'ICAR')})\n\n"
        if not templates:
            text = "आपकी फसलों के लिए कैलेंडर उपलब्ध नहीं है। कृपया अपनी फसलें अपडेट करें।"
    else:
        text = "📅 *Crop Calendar (General):*\n\n"
        for t in templates:
            text += f"🌾 *{t['crop_name']}* ({t['season']}) – {t['total_duration_days'] or '?'} days\n"
            stages = t['stages'] if isinstance(t['stages'], list) else json.loads(t['stages'])
            for s in stages[:4]:
                text += f"   ▸ {s.get('stage', '')}: {s.get('advisory', '')[:60]}…\n"
            text += f"   (Source: {t.get('source', 'ICAR')})\n\n"
        if not templates:
            text = "No calendar available for your crops. Please update your crops."

    return {"text": text}
