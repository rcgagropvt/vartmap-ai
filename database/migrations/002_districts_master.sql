-- ═══════════════════════════════════════════════════════════════
-- Migration 002: Districts Master Data
-- Pre-loaded with 780+ Indian districts + alias table.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS districts (
    id SERIAL PRIMARY KEY,
    state_name VARCHAR(50) NOT NULL,
    district_name VARCHAR(100) NOT NULL,
    district_name_hindi VARCHAR(100),
    district_name_local VARCHAR(100),  -- Bhojpuri, Marathi, etc.
    lat DECIMAL(9,6),
    lng DECIMAL(9,6),
    nearest_mandi VARCHAR(100),
    soil_zone VARCHAR(50),
    agro_climatic_zone VARCHAR(50),
    census_code VARCHAR(10),           -- Census 2011 district code
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(state_name, district_name)
);

-- Trigram index for fuzzy search on district name
CREATE INDEX IF NOT EXISTS idx_districts_name_trgm
    ON districts USING GIN (district_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_districts_name_hindi_trgm
    ON districts USING GIN (district_name_hindi gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_districts_state
    ON districts (state_name);

-- Aliases for common misspellings and alternate names
CREATE TABLE IF NOT EXISTS district_aliases (
    id SERIAL PRIMARY KEY,
    district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
    alias VARCHAR(100) NOT NULL,
    alias_type VARCHAR(20) DEFAULT 'spelling',
    -- spelling, historical, local, abbreviation
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aliases_trgm
    ON district_aliases USING GIN (alias gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_aliases_district
    ON district_aliases (district_id);

-- Indian states master (for onboarding state selection)
CREATE TABLE IF NOT EXISTS indian_states (
    id SERIAL PRIMARY KEY,
    state_name VARCHAR(50) UNIQUE NOT NULL,
    state_name_hindi VARCHAR(50),
    state_code VARCHAR(3),            -- IN-UP, IN-BR, etc.
    state_type VARCHAR(20),           -- state, union_territory
    district_count INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,     -- for display ordering
    is_active BOOLEAN DEFAULT TRUE
);

-- Pre-load states
INSERT INTO indian_states (state_name, state_name_hindi, state_code, state_type, sort_order) VALUES
('Andhra Pradesh', 'आंध्र प्रदेश', 'AP', 'state', 1),
('Arunachal Pradesh', 'अरुणाचल प्रदेश', 'AR', 'state', 2),
('Assam', 'असम', 'AS', 'state', 3),
('Bihar', 'बिहार', 'BR', 'state', 4),
('Chhattisgarh', 'छत्तीसगढ़', 'CG', 'state', 5),
('Goa', 'गोवा', 'GA', 'state', 6),
('Gujarat', 'गुजरात', 'GJ', 'state', 7),
('Haryana', 'हरियाणा', 'HR', 'state', 8),
('Himachal Pradesh', 'हिमाचल प्रदेश', 'HP', 'state', 9),
('Jharkhand', 'झारखंड', 'JH', 'state', 10),
('Karnataka', 'कर्नाटक', 'KA', 'state', 11),
('Kerala', 'केरल', 'KL', 'state', 12),
('Madhya Pradesh', 'मध्य प्रदेश', 'MP', 'state', 13),
('Maharashtra', 'महाराष्ट्र', 'MH', 'state', 14),
('Manipur', 'मणिपुर', 'MN', 'state', 15),
('Meghalaya', 'मेघालय', 'ML', 'state', 16),
('Mizoram', 'मिजोरम', 'MZ', 'state', 17),
('Nagaland', 'नागालैंड', 'NL', 'state', 18),
('Odisha', 'ओडिशा', 'OD', 'state', 19),
('Punjab', 'पंजाब', 'PB', 'state', 20),
('Rajasthan', 'राजस्थान', 'RJ', 'state', 21),
('Sikkim', 'सिक्किम', 'SK', 'state', 22),
('Tamil Nadu', 'तमिल नाडु', 'TN', 'state', 23),
('Telangana', 'तेलंगाना', 'TS', 'state', 24),
('Tripura', 'त्रिपुरा', 'TR', 'state', 25),
('Uttar Pradesh', 'उत्तर प्रदेश', 'UP', 'state', 26),
('Uttarakhand', 'उत्तराखंड', 'UK', 'state', 27),
('West Bengal', 'पश्चिम बंगाल', 'WB', 'state', 28),
('Andaman and Nicobar Islands', 'अंडमान और निकोबार', 'AN', 'union_territory', 29),
('Chandigarh', 'चंडीगढ़', 'CH', 'union_territory', 30),
('Dadra and Nagar Haveli and Daman and Diu', 'दादरा और नगर हवेली', 'DN', 'union_territory', 31),
('Delhi', 'दिल्ली', 'DL', 'union_territory', 32),
('Jammu and Kashmir', 'जम्मू और कश्मीर', 'JK', 'union_territory', 33),
('Ladakh', 'लद्दाख', 'LA', 'union_territory', 34),
('Lakshadweep', 'लक्षद्वीप', 'LD', 'union_territory', 35),
('Puducherry', 'पुदुचेरी', 'PY', 'union_territory', 36)
ON CONFLICT (state_name) DO NOTHING;

-- NOTE: Full district data (780+ rows) is loaded via seeds/001_districts_india.csv
-- using seed_loader.py. This migration only creates the table structure.

INSERT INTO _migrations (filename) VALUES ('002_districts_master.sql')
ON CONFLICT (filename) DO NOTHING;
