# automation-service/workflows/onboarding_reminder.py

from temporalio import workflow, activity
from datetime import timedelta

@workflow.defn
class OnboardingReminderWorkflow:
    """
    Long-running workflow that sends reminders to farmers
    who started but didn't complete onboarding.
    """

    @workflow.run
    async def run(self, farmer_id: str):
        # Wait 24 hours
        await workflow.sleep(timedelta(hours=24))

        # Check if still incomplete
        status = await workflow.execute_activity(
            check_onboarding_status,
            farmer_id,
            start_to_close_timeout=timedelta(seconds=30)
        )
        if status == 'completed':
            return  # All good

        # Send first reminder
        await workflow.execute_activity(
            send_onboarding_reminder,
            args=[farmer_id, 1],
            start_to_close_timeout=timedelta(seconds=30)
        )

        # Wait 48 more hours (72h total)
        await workflow.sleep(timedelta(hours=48))

        status = await workflow.execute_activity(
            check_onboarding_status, farmer_id,
            start_to_close_timeout=timedelta(seconds=30)
        )
        if status == 'completed':
            return

        # Second reminder
        await workflow.execute_activity(
            send_onboarding_reminder,
            args=[farmer_id, 2],
            start_to_close_timeout=timedelta(seconds=30)
        )

        # Wait 4 more days (7 days total)
        await workflow.sleep(timedelta(days=4))

        status = await workflow.execute_activity(
            check_onboarding_status, farmer_id,
            start_to_close_timeout=timedelta(seconds=30)
        )
        if status == 'completed':
            return

        # Final reminder
        await workflow.execute_activity(
            send_onboarding_reminder,
            args=[farmer_id, 3],
            start_to_close_timeout=timedelta(seconds=30)
        )

        # Wait 23 more days (30 days total)
        await workflow.sleep(timedelta(days=23))

        status = await workflow.execute_activity(
            check_onboarding_status, farmer_id,
            start_to_close_timeout=timedelta(seconds=30)
        )
        if status == 'completed':
            return

        # DPDP compliance: delete partial data after 30 days
        await workflow.execute_activity(
            delete_partial_profile,
            farmer_id,
            start_to_close_timeout=timedelta(seconds=30)
        )


@activity.defn
async def check_onboarding_status(farmer_id: str) -> str:
    # Query DB for farmer.onboarding_status
    pass

@activity.defn
async def send_onboarding_reminder(farmer_id: str, reminder_number: int):
    # Send WhatsApp template message (reminder templates pre-approved)
    pass

@activity.defn
async def delete_partial_profile(farmer_id: str):
    # Delete farmer record and all associated data
    # Log deletion in audit trail
    pass
