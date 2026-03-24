"""
Crop name parsing and resolution.
"""

from src.utils.db import db_pool

CROP_ALIASES = {
    "गेहूँ": "Wheat", "gehu": "Wheat", "gehun": "Wheat", "wheat": "Wheat",
    "धान": "Rice", "dhan": "Rice", "chawal": "Rice", "चावल": "Rice", "rice": "Rice", "paddy": "Rice",
    "मक्का": "Maize", "makka": "Maize", "maize": "Maize", "corn": "Maize",
    "सरसों": "Mustard", "sarson": "Mustard", "mustard": "Mustard",
    "चना": "Chickpea", "chana": "Chickpea", "gram": "Chickpea", "chickpea": "Chickpea",
    "अरहर": "Pigeon Pea", "arhar": "Pigeon Pea", "toor": "Pigeon Pea", "tur": "Pigeon Pea",
    "गन्ना": "Sugarcane", "ganna": "Sugarcane", "sugarcane": "Sugarcane",
    "कपास": "Cotton", "kapas": "Cotton", "cotton": "Cotton",
    "सोयाबीन": "Soybean", "soybean": "Soybean", "soya": "Soybean",
    "आलू": "Potato", "aloo": "Potato", "potato": "Potato",
    "प्याज": "Onion", "pyaz": "Onion", "onion": "Onion",
    "टमाटर": "Tomato", "tamatar": "Tomato", "tomato": "Tomato",
}


async def parse_crops(input_text: str) -> list[str]:
    """Parse multiple crop names from freeform text input."""
    import re
    # Split by comma, space, and, &, aur, और
    parts = re.split(r'[,\s]+|और|aur|and|&', input_text.lower().strip())
    parts = [p.strip() for p in parts if p.strip()]

    crops = []
    seen = set()
    for part in parts:
        canonical = CROP_ALIASES.get(part)
        if canonical and canonical not in seen:
            crops.append(canonical)
            seen.add(canonical)
            continue

        # Try DB lookup
        row = await db_pool.fetchrow(
            "SELECT name FROM crops WHERE name % $1 OR name_hi % $1 ORDER BY similarity(name, $1) DESC LIMIT 1",
            part,
        )
        if row and row["name"] not in seen:
            crops.append(row["name"])
            seen.add(row["name"])

    return crops
