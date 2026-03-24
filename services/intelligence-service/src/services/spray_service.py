"""
Spray / pest-disease advisory from rule database.
"""

from src.utils.db import db_pool
import structlog

log = structlog.get_logger()

# Static advisory database for common crop-pest combinations
SPRAY_DB = {
    ("wheat", "yellow_rust"): {
        "hi": "🌾 *गेहूँ — पीला रतुआ (Yellow Rust):*\n\n💊 Propiconazole 25 EC @ 0.1% (1 ml/L पानी)\nया Tebuconazole 25.9 EC @ 1 ml/L\n\n⏰ छिड़काव सुबह या शाम करें\n🔄 10-15 दिन बाद दोबारा छिड़काव करें\n⚠️ दूध जैसी अवस्था (milking stage) के बाद छिड़काव न करें",
        "en": "🌾 *Wheat — Yellow Rust:*\n\n💊 Propiconazole 25 EC @ 0.1% (1 ml/L water)\nor Tebuconazole 25.9 EC @ 1 ml/L\n\n⏰ Spray early morning or evening\n🔄 Repeat after 10-15 days\n⚠️ Do not spray after milking stage",
    },
    ("rice", "blast"): {
        "hi": "🌾 *धान — ब्लास्ट (Blast):*\n\n💊 Tricyclazole 75 WP @ 0.6 g/L पानी\nया Isoprothiolane 40 EC @ 1.5 ml/L\n\n⏰ रोग के लक्षण दिखते ही छिड़काव करें\n🔄 7-10 दिन बाद दोबारा\n💡 नाइट्रोजन की अधिक मात्रा से बचें",
        "en": "🌾 *Rice — Blast:*\n\n💊 Tricyclazole 75 WP @ 0.6 g/L water\nor Isoprothiolane 40 EC @ 1.5 ml/L\n\n⏰ Spray at first symptoms\n🔄 Repeat after 7-10 days\n💡 Avoid excess nitrogen",
    },
    ("rice", "bph"): {
        "hi": "🌾 *धान — भूरा फुदका (BPH):*\n\n💊 Pymetrozine 50 WG @ 0.3 g/L\nया Dinotefuran 20 SG @ 0.3 g/L\n\n⏰ शाम को तने के निचले भाग पर छिड़काव करें\n💡 खेत से पानी निकालें, फिर छिड़काव करें",
        "en": "🌾 *Rice — Brown Plant Hopper (BPH):*\n\n💊 Pymetrozine 50 WG @ 0.3 g/L\nor Dinotefuran 20 SG @ 0.3 g/L\n\n⏰ Spray at stem base in evening\n💡 Drain water before spraying",
    },
    ("cotton", "bollworm"): {
        "hi": "🌾 *कपास — बॉलवर्म:*\n\n💊 Emamectin Benzoate 5 SG @ 0.4 g/L\nया Chlorantraniliprole 18.5 SC @ 0.3 ml/L\n\n⏰ फूल-बॉल अवस्था में छिड़काव\n🔄 15 दिन के अंतर पर\n💡 फेरोमोन ट्रैप लगाएं (5/एकड़)",
        "en": "🌾 *Cotton — Bollworm:*\n\n💊 Emamectin Benzoate 5 SG @ 0.4 g/L\nor Chlorantraniliprole 18.5 SC @ 0.3 ml/L\n\n⏰ Spray at flowering-boll stage\n🔄 Repeat every 15 days\n💡 Install pheromone traps (5/acre)",
    },
}


async def get_spray_advisory(
    content: str, crops: list[str], state: str | None, language: str
) -> dict | None:
    """Try to match a known crop-pest combination. Returns None if unknown (escalate to AI)."""
    content_lower = content.lower()

    # Map keywords to pest identifiers
    pest_keywords = {
        "rust": "yellow_rust", "रतुआ": "yellow_rust", "ratua": "yellow_rust",
        "blast": "blast", "ब्लास्ट": "blast", "झोंका": "blast",
        "bph": "bph", "फुदका": "bph", "hopper": "bph",
        "bollworm": "bollworm", "बॉलवर्म": "bollworm", "सुंडी": "bollworm",
    }

    detected_pest = None
    for keyword, pest_id in pest_keywords.items():
        if keyword in content_lower:
            detected_pest = pest_id
            break

    if not detected_pest:
        return None

    # Try each of the farmer's crops
    for crop in crops:
        key = (crop.lower(), detected_pest)
        if key in SPRAY_DB:
            return {"text": SPRAY_DB[key].get(language, SPRAY_DB[key]["hi"])}

    return None
