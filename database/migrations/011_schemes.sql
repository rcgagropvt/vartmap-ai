-- 011_schemes.sql
CREATE TABLE IF NOT EXISTS government_schemes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL, short_name VARCHAR(30),
    description_hi TEXT, description_en TEXT,
    eligibility_criteria JSONB,
    benefits_hi TEXT, benefits_en TEXT,
    application_url TEXT, application_steps_hi TEXT, application_steps_en TEXT,
    documents_required TEXT[],
    deadline_kharif DATE, deadline_rabi DATE,
    applicable_states TEXT[],
    min_land_bigha DECIMAL(8,2), max_land_bigha DECIMAL(8,2),
    applicable_categories caste_category_enum[],
    is_active BOOLEAN DEFAULT TRUE,
    last_updated TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO _migrations (filename) VALUES ('011_schemes.sql') ON CONFLICT DO NOTHING;
