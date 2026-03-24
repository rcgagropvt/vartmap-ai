"""
Crop calendar reminder workflow – sends stage-based reminders to farmers.
"""

from datetime import timedelta
from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.messaging import send_whatsapp_message
    from src.activities.calendar_activities import get_active_calendars, get_next_stage, update_calendar_stage


@workflow.defn
class CropReminderWorkflow:
    """Runs daily, checks all active crop calendars, sends reminders."""

    @workflow.run
    async def run(self) -> dict:
        retry = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=10))

        calendars = await workflow.execute_activity(
            get_active_calendars,
            start_to_close_timeout=timedelta(seconds=60), retry_policy=retry,
        )

        sent = 0
        for cal in calendars:
            next_stage = await workflow.execute_activity(
                get_next_stage, cal["id"],
                start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
            )

            if next_stage and next_stage.get("should_remind"):
                message = f"📅 *{cal['crop_name']}* – {next_stage['stage']}:\n{next_stage['advisory']}"
                await workflow.execute_activity(
                    send_whatsapp_message,
                    args=[cal["phone"], message],
                    start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
                )

                await workflow.execute_activity(
                    update_calendar_stage,
                    args=[cal["id"], next_stage["stage"]],
                    start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
                )
                sent += 1

        return {"calendars_checked": len(calendars), "reminders_sent": sent}
