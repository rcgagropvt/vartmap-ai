-- 010_soil_health.sql
CREATE TABLE IF NOT EXISTS district_soil_health (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    district_id INTEGER REFERENCES districts(id),
    state_name VARCHAR(50) NOT NULL,
    district_name VARCHAR(100) NOT NULL,
    data_cycle VARCHAR(20),
    samples_tested INTEGER,
    nitrogen_low_pct DECIMAL(5,2), nitrogen_medium_pct DECIMAL(5,2), nitrogen_high_pct DECIMAL(5,2), nitrogen_avg_value DECIMAL(8,2),
    phosphorus_low_pct DECIMAL(5,2), phosphorus_medium_pct DECIMAL(5,2), phosphorus_high_pct DECIMAL(5,2), phosphorus_avg_value DECIMAL(8,2),
    potassium_low_pct DECIMAL(5,2), potassium_medium_pct DECIMAL(5,2), potassium_high_pct DECIMAL(5,2), potassium_avg_value DECIMAL(8,2),
    sulphur_low_pct DECIMAL(5,2), sulphur_medium_pct DECIMAL(5,2), sulphur_high_pct DECIMAL(5,2),
    zinc_deficient_pct DECIMAL(5,2), iron_deficient_pct DECIMAL(5,2), copper_deficient_pct DECIMAL(5,2),
    manganese_deficient_pct DECIMAL(5,2), boron_deficient_pct DECIMAL(5,2),
    ph_acidic_pct DECIMAL(5,2), ph_neutral_pct DECIMAL(5,2), ph_alkaline_pct DECIMAL(5,2), ph_avg DECIMAL(4,2),
    ec_normal_pct DECIMAL(5,2), ec_saline_pct DECIMAL(5,2),
    organic_carbon_low_pct DECIMAL(5,2), organic_carbon_medium_pct DECIMAL(5,2), organic_carbon_high_pct DECIMAL(5,2),
    source_url TEXT,
    scraped_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(district_id, data_cycle)
);
CREATE TRIGGER set_soil_updated_at BEFORE UPDATE ON district_soil_health FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE IF NOT EXISTS soil_product_recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deficiency_type VARCHAR(30) NOT NULL,
    crop_name VARCHAR(50),
    product_id UUID REFERENCES products(id),
    dosage_per_bigha VARCHAR(100), dosage_per_hectare VARCHAR(100),
    application_method TEXT, application_timing TEXT,
    priority INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS soil_regional_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state_name VARCHAR(50), district_name VARCHAR(100), region_name VARCHAR(100),
    insight_text_hi TEXT NOT NULL, insight_text_bho TEXT, insight_text_en TEXT,
    deficiency_type VARCHAR(30), severity VARCHAR(10), season_relevance VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS soil_testing_labs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL, type VARCHAR(30),
    district VARCHAR(100), district_id INTEGER REFERENCES districts(id),
    state VARCHAR(50), address TEXT, phone VARCHAR(15),
    location GEOGRAPHY(POINT, 4326),
    services TEXT[], cost_range VARCHAR(50), is_active BOOLEAN DEFAULT TRUE
);
INSERT INTO _migrations (filename) VALUES ('010_soil_health.sql') ON CONFLICT DO NOTHING;
