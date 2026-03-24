from datetime import timedelta
from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.messaging import send_whatsapp_template


@workflow.defn
class CampaignWorkflow:
    @workflow.run
    async def run(self, campaign_id: str, recipients: list[dict], template: dict) -> dict:
        retry = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=5))

        sent = 0
        failed = 0
        batch_size = 50

        for i in range(0, len(recipients), batch_size):
            batch = recipients[i:i + batch_size]
            for r in batch:
                try:
                    await workflow.execute_activity(
                        send_whatsapp_template,
                        args=[r["phone"], template["name"], template.get("language", "hi"), template.get("components", [])],
                        start_to_close_timeout=timedelta(seconds=30), retry_policy=retry,
                    )
                    sent += 1
                except Exception:
                    failed += 1

            # Pacing between batches
            if i + batch_size < len(recipients):
                await workflow.sleep(timedelta(seconds=3))

        return {"campaign_id": campaign_id, "sent": sent, "failed": failed}
