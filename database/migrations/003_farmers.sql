-- ═══════════════════════════════════════════════════════════════
-- Migration 003: Farmers + Farmer Crops
-- Core entity — every feature depends on this.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS farmers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- ─── Identity ─────────────────────────────────────────────
    phone VARCHAR(15) UNIQUE,              -- May be NULL post-BSUID transition (June 2026+)
    bsuid VARCHAR(150) UNIQUE,             -- WhatsApp BSUID (live March 31, 2026)
    wa_username VARCHAR(40),               -- WhatsApp username (if adopted)
    name VARCHAR(100),                     -- MANDATORY (collected at onboarding)

    -- ─── Location ─────────────────────────────────────────────
    village VARCHAR(100),                  -- MANDATORY
    block VARCHAR(100),
    district VARCHAR(100),                 -- MANDATORY
    district_id INTEGER REFERENCES districts(id),
    state VARCHAR(50),                     -- MANDATORY
    pin_code VARCHAR(6),
    location GEOGRAPHY(POINT, 4326),       -- lat/lng from WhatsApp location share

    -- ─── Preferences ──────────────────────────────────────────
    language language_enum DEFAULT 'hi',    -- MANDATORY (collected at onboarding)
    voice_preference BOOLEAN DEFAULT FALSE,

    -- ─── Farm Details ─────────────────────────────────────────
    land_holding_bigha DECIMAL(8,2),       -- MANDATORY
    soil_type VARCHAR(50),                 -- auto-filled from district soil data
    irrigation_type irrigation_enum,
    caste_category caste_category_enum,
    aadhaar_linked BOOLEAN DEFAULT FALSE,
    kcc_holder BOOLEAN DEFAULT FALSE,

    -- ─── Acquisition ──────────────────────────────────────────
    source farmer_source_enum,
    source_campaign_id UUID,               -- which campaign brought them
    referred_by UUID REFERENCES farmers(id),
    assigned_dealer UUID,                  -- FK added after dealers table exists

    -- ─── Tier & Scoring ───────────────────────────────────────
    tier farmer_tier_enum DEFAULT 'free',
    lead_score INTEGER DEFAULT 0 CHECK (lead_score >= 0 AND lead_score <= 100),
    tags TEXT[],

    -- ─── Onboarding ──────────────────────────────────────────
    onboarding_status onboarding_status_enum DEFAULT 'new_user',
    onboarding_started_at TIMESTAMPTZ,
    onboarding_completed_at TIMESTAMPTZ,

    -- ─── Consent (DPDP Act) ──────────────────────────────────
    consent_given BOOLEAN DEFAULT FALSE,   -- MANDATORY
    consent_timestamp TIMESTAMPTZ,
    consent_version VARCHAR(10),
    consent_withdrawn_at TIMESTAMPTZ,

    -- ─── Engagement Metrics ──────────────────────────────────
    total_interactions INTEGER DEFAULT 0,
    total_purchases DECIMAL(12,2) DEFAULT 0,
    first_purchase_at TIMESTAMPTZ,
    last_active_at TIMESTAMPTZ,

    -- ─── Anti-Spam ───────────────────────────────────────────
    blocked_until TIMESTAMPTZ,
    spam_level INTEGER DEFAULT 0,

    -- ─── Reward ──────────────────────────────────────────────
    reward_tier VARCHAR(20) DEFAULT 'bronze',  -- bronze, silver, gold
    total_points INTEGER DEFAULT 0,

    -- ─── Timestamps ──────────────────────────────────────────
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at
CREATE TRIGGER set_farmers_updated_at
    BEFORE UPDATE ON farmers
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ─── Farmer Crops ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS farmer_crops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    crop_name VARCHAR(50) NOT NULL,
    variety VARCHAR(50),
    area_bigha DECIMAL(8,2),
    sowing_date DATE,
    expected_harvest_date DATE,
    current_stage VARCHAR(30),
    season season_enum,
    year INTEGER,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farmer_crops_farmer
    ON farmer_crops (farmer_id);

CREATE INDEX IF NOT EXISTS idx_farmer_crops_active
    ON farmer_crops (farmer_id, is_active) WHERE is_active = TRUE;

INSERT INTO _migrations (filename) VALUES ('003_farmers.sql')
ON CONFLICT (filename) DO NOTHING;
