-- ═══════════════════════════════════════════════════════════════
-- Migration 005: Products + Product Authentication Codes
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    brand VARCHAR(50),
    category VARCHAR(30),                  -- fungicide, insecticide, fertilizer, etc.
    subcategory VARCHAR(30),
    active_ingredient VARCHAR(100),
    formulation VARCHAR(50),               -- EC, WP, SC, SL, etc.
    target_pests TEXT[],
    target_diseases TEXT[],
    target_crops TEXT[],
    target_deficiencies TEXT[],            -- for fertilizers: nitrogen, zinc, etc.
    dosage_per_acre VARCHAR(100),
    dosage_per_bigha VARCHAR(100),
    application_method TEXT,
    safety_precautions TEXT,
    re_entry_interval VARCHAR(50),         -- hours/days after spray
    pre_harvest_interval VARCHAR(50),      -- days before harvest
    mrp DECIMAL(10,2),
    dealer_price DECIMAL(10,2),
    pack_sizes JSONB,                      -- [{size: "500ml", mrp: 350}, ...]
    image_url TEXT,
    sku VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER set_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_products_category
    ON products (category) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_products_diseases
    ON products USING GIN (target_diseases);

CREATE INDEX IF NOT EXISTS idx_products_crops
    ON products USING GIN (target_crops);

-- ─── Product Authentication Codes ─────────────────────────────
CREATE TABLE IF NOT EXISTS product_auth_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id),
    code CITEXT UNIQUE NOT NULL,           -- case-insensitive
    batch_number VARCHAR(50),
    mfg_date DATE,
    expiry_date DATE,
    dealer_id UUID,                        -- which dealer received this batch
    first_scanned_at TIMESTAMPTZ,
    first_scanned_by UUID REFERENCES farmers(id),
    first_scanned_location GEOGRAPHY(POINT, 4326),
    scan_count INTEGER DEFAULT 0,
    is_flagged BOOLEAN DEFAULT FALSE,
    flag_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_code
    ON product_auth_codes (code);

CREATE INDEX IF NOT EXISTS idx_auth_codes_product
    ON product_auth_codes (product_id);

CREATE INDEX IF NOT EXISTS idx_auth_codes_flagged
    ON product_auth_codes (is_flagged) WHERE is_flagged = TRUE;

INSERT INTO _migrations (filename) VALUES ('005_products.sql')
ON CONFLICT (filename) DO NOTHING;
