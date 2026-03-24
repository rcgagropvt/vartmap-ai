"""
Product verification service – checks authenticity of agri-inputs.
"""

from src.utils.db import db_pool
import structlog

log = structlog.get_logger()


async def verify_product(content: str, language: str) -> dict:
    """Verify product by batch number, barcode, or name."""

    # Extract potential batch/barcode from content
    import re
    batch_match = re.search(r'[A-Z0-9]{4,}[-/]?[A-Z0-9]{2,}', content.upper())
    batch_code = batch_match.group(0) if batch_match else None

    result = None
    if batch_code:
        # Search by auth code
        result = await db_pool.fetchrow(
            """SELECT p.brand_name, p.product_name, p.category, p.manufacturer,
                      p.cibrc_number, p.is_genuine, pac.batch_number, pac.mfg_date, pac.expiry_date
               FROM product_auth_codes pac
               JOIN products p ON pac.product_id = p.id
               WHERE UPPER(pac.auth_code) = $1 OR UPPER(pac.batch_number) = $1
               LIMIT 1""",
            batch_code,
        )

    if not result:
        # Search by product name
        result = await db_pool.fetchrow(
            """SELECT brand_name, product_name, category, manufacturer,
                      cibrc_number, is_genuine
               FROM products
               WHERE product_name % $1 OR brand_name % $1
               ORDER BY similarity(product_name, $1) DESC
               LIMIT 1""",
            content,
        )

    if result:
        if result['is_genuine']:
            if language == "hi":
                text = f"✅ *उत्पाद सत्यापित — असली*\n\n"
                text += f"🏭 ब्रांड: {result['brand_name']}\n"
                text += f"📦 उत्पाद: {result['product_name']}\n"
                text += f"🏢 निर्माता: {result['manufacturer']}\n"
                text += f"📋 CIBRC: {result.get('cibrc_number', 'N/A')}\n"
                if result.get('expiry_date'):
                    text += f"📅 एक्सपायरी: {result['expiry_date']}\n"
            else:
                text = f"✅ *Product Verified — Genuine*\n\n"
                text += f"🏭 Brand: {result['brand_name']}\n"
                text += f"📦 Product: {result['product_name']}\n"
                text += f"🏢 Manufacturer: {result['manufacturer']}\n"
                text += f"📋 CIBRC: {result.get('cibrc_number', 'N/A')}\n"
                if result.get('expiry_date'):
                    text += f"📅 Expiry: {result['expiry_date']}\n"
        else:
            if language == "hi":
                text = "⚠️ *चेतावनी — यह उत्पाद संदिग्ध है!*\n\nकृपया इस उत्पाद का उपयोग न करें। नज़दीकी कृषि अधिकारी या किसान कॉल सेंटर 1800-180-1551 पर शिकायत करें।"
            else:
                text = "⚠️ *Warning — This product is suspicious!*\n\nPlease do not use this product. Report to your nearest agriculture officer or Kisan Call Centre 1800-180-1551."
    else:
        if language == "hi":
            text = "🔍 यह उत्पाद हमारे डेटाबेस में नहीं मिला। कृपया बैच नंबर या बारकोड की फोटो भेजें, या किसान कॉल सेंटर 1800-180-1551 से संपर्क करें।"
        else:
            text = "🔍 This product was not found in our database. Please send a photo of the batch number/barcode, or contact Kisan Call Centre 1800-180-1551."

    return {"text": text, "verified": result is not None and result.get('is_genuine', False)}
