"""
Location resolution – maps farmer input to states and districts.
"""

from src.utils.db import db_pool
import structlog

log = structlog.get_logger()

# State name → code mapping
STATE_MAP = {
    "uttar pradesh": "UP", "up": "UP", "उत्तर प्रदेश": "UP",
    "madhya pradesh": "MP", "mp": "MP", "मध्य प्रदेश": "MP",
    "maharashtra": "MH", "mh": "MH", "महाराष्ट्र": "MH",
    "rajasthan": "RJ", "rj": "RJ", "राजस्थान": "RJ",
    "bihar": "BR", "br": "BR", "बिहार": "BR",
    "punjab": "PB", "pb": "PB", "पंजाब": "PB",
    "haryana": "HR", "hr": "HR", "हरियाणा": "HR",
    "karnataka": "KA", "ka": "KA", "कर्नाटक": "KA",
    "tamil nadu": "TN", "tn": "TN", "तमिलनाडु": "TN",
    "andhra pradesh": "AP", "ap": "AP", "आंध्र प्रदेश": "AP",
    "telangana": "TG", "tg": "TG", "तेलंगाना": "TG",
    "west bengal": "WB", "wb": "WB", "पश्चिम बंगाल": "WB",
    "gujarat": "GJ", "gj": "GJ", "गुजरात": "GJ",
    "odisha": "OR", "orissa": "OR", "ओडिशा": "OR",
    "kerala": "KL", "kl": "KL", "केरल": "KL",
    "jharkhand": "JH", "jh": "JH", "झारखंड": "JH",
    "chhattisgarh": "CG", "cg": "CG", "छत्तीसगढ़": "CG",
    "assam": "AS", "as": "AS", "असम": "AS",
    "uttarakhand": "UK", "uk": "UK", "उत्तराखंड": "UK",
}


async def resolve_state(input_text: str) -> dict | None:
    normalized = input_text.strip().lower()
    code = STATE_MAP.get(normalized)
    if code:
        return {"code": code, "name": input_text.strip()}

    # Fuzzy match from DB
    row = await db_pool.fetchrow(
        """SELECT DISTINCT state_code, state_name
           FROM districts
           WHERE state_name % $1
           ORDER BY similarity(state_name, $1) DESC
           LIMIT 1""",
        input_text,
    )
    if row:
        return {"code": row["state_code"], "name": row["state_name"]}

    return None


async def resolve_district(input_text: str, state_code: str | None) -> dict | None:
    """Resolve district name with alias support and trigram fuzzy matching."""

    # 1. Exact match
    query = "SELECT id, district_name AS name FROM districts WHERE LOWER(district_name) = LOWER($1)"
    params = [input_text.strip()]
    if state_code:
        query += " AND state_code = $2"
        params.append(state_code)
    query += " LIMIT 1"

    row = await db_pool.fetchrow(query, *params)
    if row:
        return dict(row)

    # 2. Alias match
    row = await db_pool.fetchrow(
        """SELECT d.id, d.district_name AS name
           FROM district_aliases da
           JOIN districts d ON da.district_id = d.id
           WHERE LOWER(da.alias) = LOWER($1)
           LIMIT 1""",
        input_text.strip(),
    )
    if row:
        return dict(row)

    # 3. Trigram fuzzy match
    query = """SELECT id, district_name AS name, similarity(district_name, $1) AS sim
               FROM districts WHERE district_name % $1"""
    params = [input_text.strip()]
    if state_code:
        query += " AND state_code = $2"
        params.append(state_code)
    query += " ORDER BY sim DESC LIMIT 1"

    row = await db_pool.fetchrow(query, *params)
    if row and row.get("sim", 0) > 0.3:
        return {"id": row["id"], "name": row["name"]}

    return None
