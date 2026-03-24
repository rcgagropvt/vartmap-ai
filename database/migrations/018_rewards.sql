-- 018_rewards.sql
CREATE TABLE IF NOT EXISTS reward_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL, type reward_type_enum NOT NULL,
    status reward_status_enum DEFAULT 'draft',
    start_date DATE NOT NULL, end_date DATE NOT NULL,
    target_audience VARCHAR(20), geographic_scope JSONB,
    products_included UUID[], skus_included VARCHAR[],
    budget_total DECIMAL(12,2), budget_spent DECIMAL(12,2) DEFAULT 0, budget_daily_limit DECIMAL(10,2),
    total_participants INTEGER DEFAULT 0, total_entries INTEGER DEFAULT 0, total_rewards_given INTEGER DEFAULT 0,
    created_by UUID, created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reward_prizes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES reward_campaigns(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL, type prize_type_enum NOT NULL,
    value_amount DECIMAL(10,2), product_id UUID REFERENCES products(id),
    quantity_total INTEGER, quantity_remaining INTEGER,
    probability_pct DECIMAL(5,2), points_required INTEGER, tier_required VARCHAR(10),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reward_coupon_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES reward_campaigns(id),
    code CITEXT UNIQUE NOT NULL, product_id UUID REFERENCES products(id),
    sku VARCHAR(50), batch_number VARCHAR(50),
    status coupon_status_enum DEFAULT 'active',
    redeemed_by UUID REFERENCES farmers(id), redeemed_at TIMESTAMPTZ,
    redeemed_location GEOGRAPHY(POINT, 4326),
    points_awarded INTEGER, prize_won UUID REFERENCES reward_prizes(id),
    is_flagged BOOLEAN DEFAULT FALSE, flag_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coupon_code ON reward_coupon_codes (code);
CREATE INDEX IF NOT EXISTS idx_coupon_campaign ON reward_coupon_codes (campaign_id);

CREATE TABLE IF NOT EXISTS reward_points_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID NOT NULL, participant_type VARCHAR(10) NOT NULL,
    campaign_id UUID REFERENCES reward_campaigns(id),
    transaction_type points_txn_type_enum NOT NULL,
    points INTEGER NOT NULL, balance_after INTEGER NOT NULL,
    source VARCHAR(50), reference_id UUID, description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_points_participant ON reward_points_ledger (participant_id, participant_type);

CREATE TABLE IF NOT EXISTS reward_tiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID REFERENCES reward_campaigns(id),
    tier_name VARCHAR(20) NOT NULL, min_points INTEGER NOT NULL, max_points INTEGER,
    benefits JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lucky_draws (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES reward_campaigns(id),
    draw_date TIMESTAMPTZ NOT NULL, status VARCHAR(20) DEFAULT 'scheduled',
    total_entries INTEGER DEFAULT 0, winners JSONB,
    conducted_by UUID, conducted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reward_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id UUID NOT NULL, participant_type VARCHAR(10) NOT NULL,
    campaign_id UUID REFERENCES reward_campaigns(id),
    prize_id UUID REFERENCES reward_prizes(id),
    redemption_type VARCHAR(20), amount DECIMAL(10,2),
    upi_id VARCHAR(100), payment_status payment_status_enum DEFAULT 'pending',
    payment_reference VARCHAR(100),
    dealer_id UUID REFERENCES dealers(id),
    dealer_confirmed BOOLEAN DEFAULT FALSE, farmer_confirmed BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO _migrations (filename) VALUES ('018_rewards.sql') ON CONFLICT DO NOTHING;
