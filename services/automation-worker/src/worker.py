"""
Temporal worker – registers all workflows and activities.
"""

import asyncio
from temporalio.client import Client
from temporalio.worker import Worker

from src.config import settings
from src.workflows.onboarding import OnboardingWorkflow
from src.workflows.crop_reminders import CropReminderWorkflow
from src.workflows.campaign import CampaignWorkflow
from src.activities import messaging, farmer_data, calendar_activities

import structlog
log = structlog.get_logger()


async def main():
    client = await Client.connect(settings.TEMPORAL_HOST)

    worker = Worker(
        client,
        task_queue="vartmap-main",
        workflows=[
            OnboardingWorkflow,
            CropReminderWorkflow,
            CampaignWorkflow,
        ],
        activities=[
            messaging.send_whatsapp_message,
            messaging.send_whatsapp_template,
            farmer_data.get_farmer,
            farmer_data.update_farmer_field,
            farmer_data.check_farmer_onboarded,
            farmer_data.delete_farmer_data,
            calendar_activities.get_active_calendars,
            calendar_activities.get_next_stage,
            calendar_activities.update_calendar_stage,
        ],
    )

    log.info("Starting Temporal worker", task_queue="vartmap-main")
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
