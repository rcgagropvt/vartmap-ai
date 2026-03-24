"""
Soil health information service.
"""

from src.utils.db import db_pool
import structlog

log = structlog.get_logger()


async def get_soil_info(district: str | None, state: str | None) -> dict:
    """Get soil testing info and nearest labs."""

    labs = await db_pool.fetch(
        """SELECT name, address, phone, services
           FROM soil_labs
           WHERE ($1::text IS NULL OR state_code = $1)
           ORDER BY
             CASE WHEN $2::text IS NOT NULL AND LOWER(district) = LOWER($2) THEN 0 ELSE 1 END,
             name
           LIMIT 3""",
        state, district,
    )

    text_hi = "🧪 *मृदा स्वास्थ्य जानकारी:*\n\n"
    text_hi += "मिट्टी की जांच से आप सही खाद और उर्वरक की मात्रा जान सकते हैं। यह सेवा निःशुल्क है।\n\n"
    text_hi += "*निकटतम मिट्टी जांच प्रयोगशालाएं:*\n\n"
    for lab in labs:
        text_hi += f"🏛 {lab['name']}\n"
        text_hi += f"   📍 {lab['address']}\n"
        if lab['phone']:
            text_hi += f"   📞 {lab['phone']}\n"
        text_hi += "\n"
    text_hi += "💡 *सुझाव:* Soil Health Card portal: soilhealth.dac.gov.in पर अपना कार्ड देखें।"

    text_en = "🧪 *Soil Health Information:*\n\n"
    text_en += "Soil testing helps determine the right fertilizer dosage. This service is free.\n\n"
    text_en += "*Nearest Soil Testing Labs:*\n\n"
    for lab in labs:
        text_en += f"🏛 {lab['name']}\n"
        text_en += f"   📍 {lab['address']}\n"
        if lab['phone']:
            text_en += f"   📞 {lab['phone']}\n"
        text_en += "\n"
    text_en += "💡 *Tip:* Check your Soil Health Card at soilhealth.dac.gov.in"

    return {"text": {"hi": text_hi, "en": text_en}}
