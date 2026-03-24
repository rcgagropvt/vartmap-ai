"""
Onboarding reminder workflow – nudges farmers who haven't completed registration.
"""

from datetime import timedelta
from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.messaging import send_whatsapp_message
    from src.activities.farmer_data import check_farmer_onboarded, delete_farmer_data


@workflow.defn
class OnboardingWorkflow:
    @workflow.run
    async def run(self, farmer_id: str, phone: str) -> str:
        retry = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=10))

        # Wait 24 hours, then check
        await workflow.sleep(timedelta(hours=24))
        onboarded = await workflow.execute_activity(
            check_farmer_onboarded, farmer_id,
            start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
        )
        if onboarded:
            return "completed_within_24h"

        # Reminder 1: 24 hours
        await workflow.execute_activity(
            send_whatsapp_message,
            args=[phone, "🙏 आपने पंजीकरण पूरा नहीं किया। कृपया VartMap कृषि सहायक में जवाब दें और अपनी जानकारी भरें।"],
            start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
        )

        # Wait 48 more hours (72h total)
        await workflow.sleep(timedelta(hours=48))
        onboarded = await workflow.execute_activity(
            check_farmer_onboarded, farmer_id,
            start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
        )
        if onboarded:
            return "completed_within_72h"

        # Reminder 2: 72 hours
        await workflow.execute_activity(
            send_whatsapp_message,
            args=[phone, "📋 आपका पंजीकरण अभी बाकी है। 'hi' भेजें और शुरू करें — मंडी भाव, मौसम, फसल सलाह सब मिलेगा!"],
            start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
        )

        # Wait until day 7
        await workflow.sleep(timedelta(days=4))
        onboarded = await workflow.execute_activity(
            check_farmer_onboarded, farmer_id,
            start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
        )
        if onboarded:
            return "completed_within_7d"

        # Final reminder at day 7
        await workflow.execute_activity(
            send_whatsapp_message,
            args=[phone, "⏰ अंतिम अनुस्मारक: पंजीकरण 30 दिनों में नहीं होने पर आपका डेटा हटा दिया जाएगा। अभी 'hi' भेजें!"],
            start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
        )

        # Wait until day 30
        await workflow.sleep(timedelta(days=23))
        onboarded = await workflow.execute_activity(
            check_farmer_onboarded, farmer_id,
            start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
        )
        if onboarded:
            return "completed_within_30d"

        # Delete data (GDPR/consent compliance)
        await workflow.execute_activity(
            delete_farmer_data, farmer_id,
            start_to_close_timeout=timedelta(seconds=60), retry_policy=retry,
        )
        return "expired_data_deleted"
