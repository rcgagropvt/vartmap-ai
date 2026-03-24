"""
Rule-based intent matching – handles 70-80% of farmer queries without AI.
"""

import re
from typing import Optional
from src.config import settings
from src.utils.logging import setup_logging

log = setup_logging()

# ── Intent patterns (Hindi + English) ──────────────────────
INTENT_PATTERNS = {
    "mandi_price": [
        r"(?:mandi|मंडी|भाव|bhav|rate|price|दाम|dam|बाज़ार|bazar|market)",
        r"(?:कितने|kitne|kitna|कितना)\s*(?:में|me|mai)\s*(?:बिक|bik|मिल|mil)",
    ],
    "weather": [
        r"(?:mausam|मौसम|weather|बारिश|barish|rain|तापमान|temperature|temp)",
        r"(?:कब|kab)\s*(?:बारिश|barish|rain|पानी|paani)",
    ],
    "soil_health": [
        r"(?:मिट्टी|mitti|soil|भूमि|bhumi|land\s*test|मृदा|mrida)",
        r"(?:soil\s*health|मृदा\s*स्वास्थ्य|soil\s*test|जांच)",
    ],
    "spray_advisory": [
        r"(?:spray|स्प्रे|छिड़काव|chhidkav|dawai|दवाई|कीटनाशक|pesticide|fungicide|फफूंदनाशक)",
        r"(?:कीड़|keed|pest|rogue|disease|बीमार|bimari|rog|रोग)",
    ],
    "scheme": [
        r"(?:yojana|योजना|scheme|सरकारी|government|subsidy|सब्सिडी|pm.?kisan|किसान\s*सम्मान)",
        r"(?:पंजीकरण|registration|apply|आवेदन|aavedan)",
    ],
    "crop_calendar": [
        r"(?:buwai|बुवाई|sowing|बोना|bona|कब\s*बोए|crop\s*calendar)",
        r"(?:कटाई|katai|harvest|तुड़ाई|tudai|उगाना|ugana)",
    ],
    "product_verify": [
        r"(?:asli|असली|nakli|नकली|genuine|fake|verify|सत्यापन|original|duplicate)",
        r"(?:barcode|बारकोड|batch|बैच|QR|qr)",
    ],
    "profile": [
        r"(?:profile|प्रोफ़ाइल|mera\s*naam|मेरा\s*नाम|meri\s*jankari|मेरी\s*जानकारी|account|खाता)",
    ],
    "menu": [
        r"^(?:menu|मेन्यू|help|मदद|sahayata|सहायता|hi|hello|नमस्ते|namaste)$",
    ],
    "rewards": [
        r"(?:reward|पुरस्कार|points|पॉइंट|referral|रेफरल|invite|बुलाना)",
    ],
    "expert": [
        r"(?:expert|विशेषज्ञ|scientist|वैज्ञानिक|kisan\s*call\s*center|किसान\s*कॉल)",
    ],
    "language_change": [
        r"(?:language|भाषा|bhasha|english|hindi|हिंदी|अंग्रेज़ी|angrezi)",
    ],
}


async def match_rule(content: str, language: str, payload) -> Optional[dict]:
    """Try to match the message against rule-based patterns. Returns handler result or None."""
    content_lower = content.lower().strip()

    for intent, patterns in INTENT_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, content_lower, re.IGNORECASE):
                handler = INTENT_HANDLERS.get(intent)
                if handler:
                    return await handler(content, language, payload)
                return None

    return None  # No rule matched → falls through to AI


# ── Intent Handlers ────────────────────────────────────────

async def handle_mandi_price(content: str, language: str, payload) -> dict:
    """Fetch mandi prices from DB/Agmarknet and respond."""
    from src.services.mandi_service import get_mandi_prices
    from src.engine.router import send_response

    prices = await get_mandi_prices(
        crop_query=content,
        state=payload.state,
        district=payload.district,
        farmer_crops=payload.crops,
    )

    if language == "hi":
        text = "📊 *आज के मंडी भाव:*\n\n"
        for p in prices[:5]:
            text += f"🌾 {p['crop']} – {p['market']}\n"
            text += f"   न्यूनतम: ₹{p['min_price']} | अधिकतम: ₹{p['max_price']} | मॉडल: ₹{p['modal_price']}/क्विंटल\n\n"
        if not prices:
            text = "अभी इस फसल/मंडी के भाव उपलब्ध नहीं हैं। कृपया बाद में प्रयास करें।"
    else:
        text = "📊 *Today's Mandi Prices:*\n\n"
        for p in prices[:5]:
            text += f"🌾 {p['crop']} – {p['market']}\n"
            text += f"   Min: ₹{p['min_price']} | Max: ₹{p['max_price']} | Modal: ₹{p['modal_price']}/quintal\n\n"
        if not prices:
            text = "Prices not available for this crop/market right now. Please try later."

    await send_response(payload, text)
    return {"feature": "mandi_price", "source": "rule_engine", "response": text}


async def handle_weather(content: str, language: str, payload) -> dict:
    from src.services.weather_service import get_weather
    from src.engine.router import send_response

    weather = await get_weather(payload.district, payload.state)

    if language == "hi":
        text = f"🌤 *{payload.district or 'आपके क्षेत्र'} का मौसम:*\n\n"
        text += f"🌡 तापमान: {weather['temp']}°C\n"
        text += f"💧 नमी: {weather['humidity']}%\n"
        text += f"🌧 बारिश की संभावना: {weather['rain_chance']}%\n"
        text += f"💨 हवा: {weather['wind_speed']} km/h\n\n"
        text += f"📋 *सलाह:* {weather['advisory_hi']}"
    else:
        text = f"🌤 *Weather for {payload.district or 'your area'}:*\n\n"
        text += f"🌡 Temperature: {weather['temp']}°C\n"
        text += f"💧 Humidity: {weather['humidity']}%\n"
        text += f"🌧 Rain chance: {weather['rain_chance']}%\n"
        text += f"💨 Wind: {weather['wind_speed']} km/h\n\n"
        text += f"📋 *Advisory:* {weather['advisory_en']}"

    await send_response(payload, text)
    return {"feature": "weather", "source": "rule_engine", "response": text}


async def handle_soil_health(content: str, language: str, payload) -> dict:
    from src.services.soil_service import get_soil_info
    from src.engine.router import send_response

    info = await get_soil_info(payload.district, payload.state)
    await send_response(payload, info["text"][language])
    return {"feature": "soil_health", "source": "rule_engine"}


async def handle_spray_advisory(content: str, language: str, payload) -> dict:
    # This often needs AI for specific pest identification – return None to escalate
    # unless the crop + common pest is in our rule database
    from src.services.spray_service import get_spray_advisory
    from src.engine.router import send_response

    advisory = await get_spray_advisory(content, payload.crops, payload.state, language)
    if advisory:
        await send_response(payload, advisory["text"])
        return {"feature": "spray_advisory", "source": "rule_engine"}
    return None  # escalate to AI


async def handle_scheme(content: str, language: str, payload) -> dict:
    from src.services.scheme_service import search_schemes
    from src.engine.router import send_response

    schemes = await search_schemes(content, payload.state, language)
    await send_response(payload, schemes["text"])
    return {"feature": "scheme", "source": "rule_engine"}


async def handle_crop_calendar(content: str, language: str, payload) -> dict:
    from src.services.calendar_service import get_crop_calendar
    from src.engine.router import send_response

    cal = await get_crop_calendar(payload.farmerId, payload.crops, payload.state, language)
    await send_response(payload, cal["text"])
    return {"feature": "crop_calendar", "source": "rule_engine"}


async def handle_product_verify(content: str, language: str, payload) -> dict:
    from src.services.product_service import verify_product
    from src.engine.router import send_response

    result = await verify_product(content, language)
    await send_response(payload, result["text"])
    return {"feature": "product_verify", "source": "rule_engine"}


async def handle_profile(content: str, language: str, payload) -> dict:
    from src.services.profile_service import get_profile
    from src.engine.router import send_response

    profile = await get_profile(payload.farmerId, language)
    await send_response(payload, profile["text"])
    return {"feature": "profile", "source": "rule_engine"}


async def handle_menu(content: str, language: str, payload) -> dict:
    from src.engine.router import send_response
    import httpx

    menu = build_menu(language)
    # Send as interactive list
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{settings.WA_GATEWAY_URL}/api/v1/messages/send",
            json={
                "to": payload.phone,
                "type": "interactive",
                "body": menu,
                "farmer_id": payload.farmerId,
            },
            timeout=10,
        )
    return {"feature": "menu", "source": "rule_engine"}


async def handle_rewards(content: str, language: str, payload) -> dict:
    from src.services.reward_service import get_rewards_info
    from src.engine.router import send_response

    info = await get_rewards_info(payload.farmerId, language)
    await send_response(payload, info["text"])
    return {"feature": "rewards", "source": "rule_engine"}


async def handle_expert(content: str, language: str, payload) -> dict:
    from src.engine.router import send_response

    if language == "hi":
        text = ("🧑‍🌾 *विशेषज्ञ सहायता:*\n\n"
                "1️⃣ किसान कॉल सेंटर: *1800-180-1551* (निःशुल्क)\n"
                "2️⃣ KVK हेल्पलाइन: अपने ज़िले के KVK से संपर्क करें\n"
                "3️⃣ यहाँ अपना सवाल लिखें — हम विशेषज्ञ से जवाब दिलवाएंगे (24-48 घंटे)")
    else:
        text = ("🧑‍🌾 *Expert Help:*\n\n"
                "1️⃣ Kisan Call Centre: *1800-180-1551* (toll-free)\n"
                "2️⃣ KVK Helpline: Contact your district KVK\n"
                "3️⃣ Type your question here – we'll get an expert response (24-48 hrs)")
    await send_response(payload, text)
    return {"feature": "expert_escalation", "source": "rule_engine"}


async def handle_language_change(content: str, language: str, payload) -> dict:
    from src.utils.db import db_pool
    from src.engine.router import send_response
    import httpx

    # Send language selection interactive buttons
    buttons = {
        "type": "button",
        "body": {"text": "भाषा चुनें / Choose language:"},
        "action": {
            "buttons": [
                {"type": "reply", "reply": {"id": "lang_hi", "title": "हिंदी"}},
                {"type": "reply", "reply": {"id": "lang_en", "title": "English"}},
            ]
        },
    }
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{settings.WA_GATEWAY_URL}/api/v1/messages/send",
            json={"to": payload.phone, "type": "interactive", "body": buttons, "farmer_id": payload.farmerId},
            timeout=10,
        )
    return {"feature": "language_change", "source": "rule_engine"}


def build_menu(language: str) -> dict:
    if language == "hi":
        return {
            "type": "list",
            "header": {"type": "text", "text": "🌾 कृषि सहायक मेन्यू"},
            "body": {"text": "नीचे से विकल्प चुनें:"},
            "action": {
                "button": "विकल्प देखें",
                "sections": [
                    {
                        "title": "मुख्य सेवाएं",
                        "rows": [
                            {"id": "menu_mandi", "title": "📊 मंडी भाव", "description": "आज के बाज़ार भाव देखें"},
                            {"id": "menu_weather", "title": "🌤 मौसम", "description": "अपने क्षेत्र का मौसम"},
                            {"id": "menu_spray", "title": "💊 स्प्रे सलाह", "description": "कीट/रोग उपचार"},
                            {"id": "menu_calendar", "title": "📅 फसल कैलेंडर", "description": "बुवाई-कटाई अनुसूची"},
                            {"id": "menu_soil", "title": "🧪 मिट्टी जांच", "description": "मृदा स्वास्थ्य जानकारी"},
                        ],
                    },
                    {
                        "title": "अन्य",
                        "rows": [
                            {"id": "menu_scheme", "title": "🏛 सरकारी योजना", "description": "योजनाओं की जानकारी"},
                            {"id": "menu_verify", "title": "✅ उत्पाद सत्यापन", "description": "असली/नकली जांच"},
                            {"id": "menu_profile", "title": "👤 मेरा प्रोफ़ाइल", "description": "जानकारी देखें/बदलें"},
                            {"id": "menu_rewards", "title": "🎁 रिवार्ड", "description": "पॉइंट्स और रेफरल"},
                            {"id": "menu_expert", "title": "🧑‍🌾 विशेषज्ञ", "description": "कृषि वैज्ञानिक से बात"},
                        ],
                    },
                ],
            },
        }
    else:
        return {
            "type": "list",
            "header": {"type": "text", "text": "🌾 Krishi Sahayak Menu"},
            "body": {"text": "Choose an option below:"},
            "action": {
                "button": "View Options",
                "sections": [
                    {
                        "title": "Main Services",
                        "rows": [
                            {"id": "menu_mandi", "title": "📊 Mandi Prices", "description": "Today's market rates"},
                            {"id": "menu_weather", "title": "🌤 Weather", "description": "Local weather forecast"},
                            {"id": "menu_spray", "title": "💊 Spray Advisory", "description": "Pest/disease treatment"},
                            {"id": "menu_calendar", "title": "📅 Crop Calendar", "description": "Sowing-harvest schedule"},
                            {"id": "menu_soil", "title": "🧪 Soil Health", "description": "Soil test information"},
                        ],
                    },
                    {
                        "title": "More",
                        "rows": [
                            {"id": "menu_scheme", "title": "🏛 Govt Schemes", "description": "Scheme information"},
                            {"id": "menu_verify", "title": "✅ Product Verify", "description": "Check genuine/fake"},
                            {"id": "menu_profile", "title": "👤 My Profile", "description": "View/edit info"},
                            {"id": "menu_rewards", "title": "🎁 Rewards", "description": "Points & referrals"},
                            {"id": "menu_expert", "title": "🧑‍🌾 Expert", "description": "Talk to agri scientist"},
                        ],
                    },
                ],
            },
        }


# ── Handler mapping ────────────────────────────────────────
INTENT_HANDLERS = {
    "mandi_price": handle_mandi_price,
    "weather": handle_weather,
    "soil_health": handle_soil_health,
    "spray_advisory": handle_spray_advisory,
    "scheme": handle_scheme,
    "crop_calendar": handle_crop_calendar,
    "product_verify": handle_product_verify,
    "profile": handle_profile,
    "menu": handle_menu,
    "rewards": handle_rewards,
    "expert": handle_expert,
    "language_change": handle_language_change,
}
