"""
Farmer profile service.
"""

from src.utils.db import db_pool


async def get_profile(farmer_id: str, language: str) -> dict:
    farmer = await db_pool.fetchrow(
        """SELECT name, phone, state_code, district, village, crops,
                  land_acres, tier, preferred_language,
                  consent_given, created_at
           FROM farmers WHERE id = $1""",
        farmer_id,
    )

    if not farmer:
        text = "प्रोफ़ाइल नहीं मिला।" if language == "hi" else "Profile not found."
        return {"text": text}

    if language == "hi":
        text = "👤 *आपका प्रोफ़ाइल:*\n\n"
        text += f"📛 नाम: {farmer['name'] or '—'}\n"
        text += f"📱 फ़ोन: {farmer['phone']}\n"
        text += f"📍 राज्य: {farmer['state_code'] or '—'}\n"
        text += f"📍 ज़िला: {farmer['district'] or '—'}\n"
        text += f"🏘 गांव: {farmer['village'] or '—'}\n"
        text += f"🌾 फसलें: {', '.join(farmer['crops']) if farmer['crops'] else '—'}\n"
        text += f"📐 खेत: {farmer['land_acres'] or '—'} एकड़\n"
        text += f"⭐ टियर: {farmer['tier'] or 'basic'}\n"
        text += f"🗣 भाषा: {'हिंदी' if farmer['preferred_language'] == 'hi' else 'English'}\n\n"
        text += "बदलने के लिए बोलें: 'नाम बदलें' या 'भाषा बदलें'"
    else:
        text = "👤 *Your Profile:*\n\n"
        text += f"📛 Name: {farmer['name'] or '—'}\n"
        text += f"📱 Phone: {farmer['phone']}\n"
        text += f"📍 State: {farmer['state_code'] or '—'}\n"
        text += f"📍 District: {farmer['district'] or '—'}\n"
        text += f"🏘 Village: {farmer['village'] or '—'}\n"
        text += f"🌾 Crops: {', '.join(farmer['crops']) if farmer['crops'] else '—'}\n"
        text += f"📐 Land: {farmer['land_acres'] or '—'} acres\n"
        text += f"⭐ Tier: {farmer['tier'] or 'basic'}\n"
        text += f"🗣 Language: {'Hindi' if farmer['preferred_language'] == 'hi' else 'English'}\n\n"
        text += "To update, say: 'change name' or 'change language'"

    return {"text": text}
