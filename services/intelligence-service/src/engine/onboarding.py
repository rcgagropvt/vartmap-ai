"""
Handles onboarding state machine steps when farmer hasn't completed registration.
"""

from src.utils.db import db_pool
from src.utils.redis_client import redis_pool
from src.config import settings
import httpx
import structlog
import json

log = structlog.get_logger()

ONBOARDING_STATES = [
    "language", "name", "state", "district", "village", "crops", "land_size", "consent"
]


async def handle_onboarding_step(payload) -> dict:
    farmer_id = payload.farmerId
    content = payload.content.strip()
    phone = payload.phone

    # Get current onboarding state from Redis
    state_key = f"onboard:state:{farmer_id}"
    current_state = await redis_pool.get(state_key) or "language"

    handler = STEP_HANDLERS.get(current_state)
    if not handler:
        # Default to language
        current_state = "language"
        handler = STEP_HANDLERS["language"]

    result = await handler(farmer_id, phone, content, payload)

    if result.get("advance"):
        # Move to next state
        idx = ONBOARDING_STATES.index(current_state)
        if idx + 1 < len(ONBOARDING_STATES):
            next_state = ONBOARDING_STATES[idx + 1]
            await redis_pool.set(state_key, next_state, ex=86400 * 30)
            # Send next prompt
            await send_onboarding_prompt(phone, next_state, farmer_id, result.get("language", "hi"))
        else:
            # Onboarding complete
            await db_pool.execute(
                "UPDATE farmers SET onboarding_complete = TRUE, updated_at = NOW() WHERE id = $1",
                farmer_id,
            )
            await redis_pool.client.delete(state_key)
            await send_welcome_message(phone, farmer_id, result.get("language", "hi"))

    return {"feature": "onboarding", "source": "onboarding_engine", "step": current_state}


async def step_language(farmer_id, phone, content, payload):
    lang = "hi"
    if content.lower() in ("english", "en", "2", "eng", "अंग्रेज़ी"):
        lang = "en"
    await db_pool.execute(
        "UPDATE farmers SET preferred_language = $1, updated_at = NOW() WHERE id = $2",
        lang, farmer_id,
    )
    return {"advance": True, "language": lang}


async def step_name(farmer_id, phone, content, payload):
    name = content.strip()[:100]
    if len(name) < 2:
        await send_text(phone, farmer_id, "कृपया अपना नाम बताएं:" if payload.language == "hi" else "Please enter your name:")
        return {"advance": False}
    await db_pool.execute(
        "UPDATE farmers SET name = $1, updated_at = NOW() WHERE id = $2",
        name, farmer_id,
    )
    return {"advance": True, "language": payload.language}


async def step_state(farmer_id, phone, content, payload):
    from src.services.location_service import resolve_state
    state = await resolve_state(content)
    if not state:
        await send_text(phone, farmer_id, "राज्य पहचाना नहीं गया। कृपया दोबारा लिखें:" if payload.language == "hi" else "State not recognized. Please try again:")
        return {"advance": False}
    await db_pool.execute(
        "UPDATE farmers SET state_code = $1, updated_at = NOW() WHERE id = $2",
        state["code"], farmer_id,
    )
    return {"advance": True, "language": payload.language}


async def step_district(farmer_id, phone, content, payload):
    from src.services.location_service import resolve_district
    district = await resolve_district(content, payload.state)
    if not district:
        await send_text(phone, farmer_id, "ज़िला पहचाना नहीं गया। कृपया दोबारा लिखें:" if payload.language == "hi" else "District not recognized. Please try again:")
        return {"advance": False}
    await db_pool.execute(
        "UPDATE farmers SET district = $1, updated_at = NOW() WHERE id = $2",
        district["name"], farmer_id,
    )
    return {"advance": True, "language": payload.language}


async def step_village(farmer_id, phone, content, payload):
    village = content.strip()[:100]
    await db_pool.execute(
        "UPDATE farmers SET village = $1, updated_at = NOW() WHERE id = $2",
        village, farmer_id,
    )
    return {"advance": True, "language": payload.language}


async def step_crops(farmer_id, phone, content, payload):
    from src.services.crop_service import parse_crops
    crops = await parse_crops(content)
    if not crops:
        await send_text(phone, farmer_id, "कृपया अपनी फसलें बताएं (जैसे: गेहूँ, धान, सरसों):" if payload.language == "hi" else "Please enter your crops (e.g. wheat, rice, mustard):")
        return {"advance": False}
    # Store in farmer_crops table
    for crop in crops:
        await db_pool.execute(
            "INSERT INTO farmer_crops (farmer_id, crop_name) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            farmer_id, crop,
        )
    await db_pool.execute(
        "UPDATE farmers SET crops = $1, updated_at = NOW() WHERE id = $2",
        crops, farmer_id,
    )
    return {"advance": True, "language": payload.language}


async def step_land_size(farmer_id, phone, content, payload):
    import re
    match = re.search(r"(\d+\.?\d*)", content)
    if not match:
        await send_text(phone, farmer_id, "कृपया खेत का क्षेत्रफल एकड़ में बताएं (जैसे: 5):" if payload.language == "hi" else "Please enter land size in acres (e.g. 5):")
        return {"advance": False}
    acres = float(match.group(1))
    await db_pool.execute(
        "UPDATE farmers SET land_acres = $1, updated_at = NOW() WHERE id = $2",
        acres, farmer_id,
    )
    return {"advance": True, "language": payload.language}


async def step_consent(farmer_id, phone, content, payload):
    content_lower = content.lower().strip()
    positive = {"yes", "हाँ", "han", "ha", "haan", "1", "ok", "agree", "सहमत"}
    if content_lower in positive:
        await db_pool.execute(
            "UPDATE farmers SET consent_given = TRUE, consent_at = NOW(), updated_at = NOW() WHERE id = $1",
            farmer_id,
        )
        return {"advance": True, "language": payload.language}
    elif content_lower in {"no", "नहीं", "nahi", "2", "disagree", "असहमत"}:
        await send_text(phone, farmer_id,
                        "आपकी जानकारी के बिना हम पूरी सेवा नहीं दे पाएंगे। आप बाद में 'हाँ' भेजकर सहमति दे सकते हैं।"
                        if payload.language == "hi" else
                        "Without consent we cannot provide full service. You can send 'yes' later to consent.")
        return {"advance": False}
    else:
        await send_text(phone, farmer_id,
                        "कृपया 'हाँ' या 'नहीं' में जवाब दें:" if payload.language == "hi" else "Please reply 'yes' or 'no':")
        return {"advance": False}


STEP_HANDLERS = {
    "language": step_language,
    "name": step_name,
    "state": step_state,
    "district": step_district,
    "village": step_village,
    "crops": step_crops,
    "land_size": step_land_size,
    "consent": step_consent,
}


async def send_onboarding_prompt(phone, step, farmer_id, language):
    prompts = {
        "name": {"hi": "🙏 नमस्ते! VartMap कृषि सहायक में आपका स्वागत है।\n\nकृपया अपना नाम बताएं:", "en": "🙏 Welcome to VartMap Krishi Sahayak!\n\nPlease enter your name:"},
        "state": {"hi": "आपका राज्य कौन सा है?", "en": "Which state are you from?"},
        "district": {"hi": "आपका ज़िला कौन सा है?", "en": "Which district?"},
        "village": {"hi": "आपका गांव/ब्लॉक?", "en": "Your village/block?"},
        "crops": {"hi": "आप कौन सी फसलें उगाते हैं? (जैसे: गेहूँ, धान, सरसों)", "en": "What crops do you grow? (e.g. wheat, rice, mustard)"},
        "land_size": {"hi": "आपके खेत का क्षेत्रफल कितने एकड़ है?", "en": "What is your land size in acres?"},
        "consent": {"hi": "क्या आप अपनी जानकारी VartMap सेवाओं के लिए साझा करने की सहमति देते हैं?\n\n(हाँ / नहीं)", "en": "Do you consent to share your information for VartMap services?\n\n(yes / no)"},
    }
    prompt = prompts.get(step, {})
    text = prompt.get(language, prompt.get("hi", ""))
    if text:
        await send_text(phone, farmer_id, text)


async def send_welcome_message(phone, farmer_id, language):
    if language == "hi":
        text = ("✅ *पंजीकरण सफल!* 🎉\n\n"
                "अब आप इन सेवाओं का उपयोग कर सकते हैं:\n"
                "📊 मंडी भाव\n🌤 मौसम\n💊 स्प्रे सलाह\n📅 फसल कैलेंडर\n🏛 सरकारी योजना\n✅ उत्पाद सत्यापन\n\n"
                "'मेन्यू' लिखें सभी विकल्प देखने के लिए।")
    else:
        text = ("✅ *Registration complete!* 🎉\n\n"
                "You can now use:\n"
                "📊 Mandi Prices\n🌤 Weather\n💊 Spray Advisory\n📅 Crop Calendar\n🏛 Govt Schemes\n✅ Product Verification\n\n"
                "Type 'menu' to see all options.")
    await send_text(phone, farmer_id, text)


async def send_text(phone, farmer_id, text):
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{settings.WA_GATEWAY_URL}/api/v1/messages/send",
            json={"to": phone, "type": "text", "body": text, "farmer_id": farmer_id},
            timeout=10,
        )
