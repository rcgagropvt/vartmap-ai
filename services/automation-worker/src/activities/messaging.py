import httpx
from temporalio import activity
from src.config import settings


@activity.defn
async def send_whatsapp_message(phone: str, text: str) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{settings.WA_GATEWAY_URL}/api/v1/messages/send",
            json={"to": phone, "type": "text", "body": text},
        )
        resp.raise_for_status()
        return resp.json()


@activity.defn
async def send_whatsapp_template(
    phone: str, template_name: str, language: str = "hi", components: list = None
) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{settings.WA_GATEWAY_URL}/api/v1/messages/send-template",
            json={
                "to": phone,
                "template_name": template_name,
                "language": language,
                "components": components or [],
            },
        )
        resp.raise_for_status()
        return resp.json()
