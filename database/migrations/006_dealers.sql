-- 006_dealers.sql
CREATE TABLE IF NOT EXISTS dealers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(15) UNIQUE,
    shop_name VARCHAR(100),
    village VARCHAR(100),
    district VARCHAR(100),
    district_id INTEGER REFERENCES districts(id),
    state VARCHAR(50),
    location GEOGRAPHY(POINT, 4326),
    referral_code CITEXT UNIQUE,
    license_number VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    is_verified BOOLEAN DEFAULT FALSE,
    rating DECIMAL(3,2) DEFAULT 0,
    total_orders INTEGER DEFAULT 0,
    total_revenue DECIMAL(14,2) DEFAULT 0,
    commission_rate DECIMAL(4,2) DEFAULT 5.00,
    total_points INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TRIGGER set_dealers_updated_at BEFORE UPDATE ON dealers FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
ALTER TABLE farmers ADD CONSTRAINT fk_farmers_dealer FOREIGN KEY (assigned_dealer) REFERENCES dealers(id);
INSERT INTO _migrations (filename) VALUES ('006_dealers.sql') ON CONFLICT DO NOTHING;
