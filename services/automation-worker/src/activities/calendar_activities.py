import asyncpg
from datetime import date, datetime
from temporalio import activity
from src.config import settings


async def _get_conn():
    return await asyncpg.connect(settings.DATABASE_URL)


@activity.defn
async def get_active_calendars() -> list[dict]:
    conn = await _get_conn()
    try:
        rows = await conn.fetch(
            """SELECT fcc.id, fcc.farmer_id, fcc.crop_name, fcc.current_stage,
                      fcc.sowing_date, fcc.next_reminder_at, f.phone, f.preferred_language
               FROM farmer_crop_calendar fcc
               JOIN farmers f ON fcc.farmer_id = f.id
               WHERE fcc.status = 'active'
                 AND fcc.reminders_enabled = TRUE
                 AND (fcc.next_reminder_at IS NULL OR fcc.next_reminder_at <= NOW())"""
        )
        return [dict(r) for r in rows]
    finally:
        await conn.close()


@activity.defn
async def get_next_stage(calendar_id: str) -> dict | None:
    conn = await _get_conn()
    try:
        row = await conn.fetchrow(
            """SELECT fcc.current_stage, fcc.sowing_date, cct.stages
               FROM farmer_crop_calendar fcc
               LEFT JOIN crop_calendar_templates cct ON fcc.template_id = cct.id
               WHERE fcc.id = $1""",
            calendar_id,
        )
        if not row or not row["stages"]:
            return None

        import json
        stages = row["stages"] if isinstance(row["stages"], list) else json.loads(row["stages"])
        current = row["current_stage"]
        sowing = row["sowing_date"]

        if not sowing:
            return None

        days_since_sowing = (date.today() - sowing).days

        for i, stage in enumerate(stages):
            if stage["stage"] == current:
                # Check if it's time for next stage
                if i + 1 < len(stages):
                    next_s = stages[i + 1]
                    if days_since_sowing >= next_s.get("start_doy", 0):
                        return {
                            "stage": next_s["stage"],
                            "advisory": next_s.get("advisory", ""),
                            "should_remind": True,
                        }
                return None

        # If no current stage matched, start from first stage
        if stages:
            return {"stage": stages[0]["stage"], "advisory": stages[0].get("advisory", ""), "should_remind": True}
        return None
    finally:
        await conn.close()


@activity.defn
async def update_calendar_stage(calendar_id: str, new_stage: str) -> bool:
    conn = await _get_conn()
    try:
        await conn.execute(
            """UPDATE farmer_crop_calendar
               SET current_stage = $1,
                   next_reminder_at = NOW() + INTERVAL '3 days',
                   stages_log = stages_log || jsonb_build_array(jsonb_build_object(
                       'stage', $1, 'started_at', NOW()::text
                   )),
                   updated_at = NOW()
               WHERE id = $2""",
            new_stage, calendar_id,
        )
        return True
    finally:
        await conn.close()
