"""
Message router – determines whether to use rule-based handling or AI pipeline.
"""

import re
from src.engine.rules import match_rule
from src.engine.ai_pipeline import run_ai_pipeline
from src.engine.anti_spam import check_spam
from src.engine.onboarding import handle_onboarding_step
from src.utils.cost_tracker import check_budget_available, get_farmer_ai_usage_today
from src.utils.semantic_cache import get_cached_response, store_cached_response
from src.config import settings
from src.utils.logging import setup_logging

log = setup_logging()


async def route_message(payload) -> dict:
    """Main routing logic."""

    farmer_id = payload.farmerId
    content = payload.content.strip()
    language = payload.language

    # ── 1. Anti-spam check ─────────────────────────────────
    spam_result = await check_spam(farmer_id, content)
    if spam_result["is_spam"]:
        log.warn("Spam detected", farmer_id=farmer_id, reason=spam_result["reason"])
        return {"feature": "spam_blocked", "source": "anti_spam"}

    # ── 2. Onboarding (if incomplete) ──────────────────────
    if not payload.onboardingComplete:
        return await handle_onboarding_step(payload)

    # ── 3. Rule-based matching (70-80% of queries) ─────────
    rule_match = await match_rule(content, language, payload)
    if rule_match:
        log.info("Rule matched", feature=rule_match["feature"], farmer_id=farmer_id)
        return rule_match

    # ── 4. Semantic cache ──────────────────────────────────
    cached = await get_cached_response(content, language, payload.state)
    if cached:
        # Send cached response to farmer
        await send_response(payload, cached["response"])
        return {"feature": "cached_ai", "source": "semantic_cache", "score": cached["score"]}

    # ── 5. Budget + rate check ─────────────────────────────
    budget_ok = await check_budget_available()
    if not budget_ok:
        await send_budget_exceeded_response(payload)
        return {"feature": "budget_exceeded", "source": "system"}

    daily_usage = await get_farmer_ai_usage_today(farmer_id)
    if daily_usage >= settings.FARMER_AI_QUERIES_PER_DAY:
        await send_daily_limit_response(payload)
        return {"feature": "daily_limit", "source": "system"}

    # ── 6. AI pipeline ─────────────────────────────────────
    ai_result = await run_ai_pipeline(payload)

    # Cache the result
    if ai_result.get("response"):
        await store_cached_response(
            content, ai_result["response"], language,
            state_code=payload.state, feature=ai_result.get("feature", "ai_general"),
        )

    return ai_result


async def send_response(payload, text: str):
    """Send text response back through WhatsApp Gateway."""
    import httpx
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{settings.WA_GATEWAY_URL}/api/v1/messages/send",
            json={
                "to": payload.phone,
                "type": "text",
                "body": text,
                "bsuid": payload.bsuid,
                "farmer_id": payload.farmerId,
            },
            timeout=10,
        )


async def send_budget_exceeded_response(payload):
    messages = {
        "hi": "🙏 अभी AI सेवा उपलब्ध नहीं है। कृपया बाद में प्रयास करें। आप अभी भी मंडी भाव, मौसम, और योजनाओं की जानकारी प्राप्त कर सकते हैं।",
        "en": "AI service is temporarily unavailable. You can still check mandi prices, weather, and schemes.",
    }
    await send_response(payload, messages.get(payload.language, messages["hi"]))


async def send_daily_limit_response(payload):
    messages = {
        "hi": "आपने आज की AI पूछताछ सीमा पूरी कर ली है। कल फिर प्रयास करें। मंडी भाव व मौसम अभी भी उपलब्ध हैं।",
        "en": "You've reached today's AI query limit. Try again tomorrow. Mandi prices and weather are still available.",
    }
    await send_response(payload, messages.get(payload.language, messages["hi"]))
