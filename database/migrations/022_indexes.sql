-- 022_indexes.sql (consolidated secondary indexes)
-- Farmers
CREATE INDEX IF NOT EXISTS idx_farmers_district ON farmers (district);
CREATE INDEX IF NOT EXISTS idx_farmers_state ON farmers (state);
CREATE INDEX IF NOT EXISTS idx_farmers_lead_score ON farmers (lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_farmers_last_active ON farmers (last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_farmers_location ON farmers USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_farmers_onboarding ON farmers (onboarding_status);
CREATE INDEX IF NOT EXISTS idx_farmers_tier ON farmers (tier);
CREATE INDEX IF NOT EXISTS idx_farmers_source ON farmers (source);
CREATE INDEX IF NOT EXISTS idx_farmers_created ON farmers (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_farmers_bsuid ON farmers (bsuid) WHERE bsuid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_farmers_phone_trgm ON farmers USING GIN (phone gin_trgm_ops);

-- Dealers
CREATE INDEX IF NOT EXISTS idx_dealers_district ON dealers (district);
CREATE INDEX IF NOT EXISTS idx_dealers_location ON dealers USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_dealers_referral ON dealers (referral_code);

-- Soil testing labs
CREATE INDEX IF NOT EXISTS idx_labs_district ON soil_testing_labs (district_id);
CREATE INDEX IF NOT EXISTS idx_labs_location ON soil_testing_labs USING GIST (location);

INSERT INTO _migrations (filename) VALUES ('022_indexes.sql') ON CONFLICT DO NOTHING;
