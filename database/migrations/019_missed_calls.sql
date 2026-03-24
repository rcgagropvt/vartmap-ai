-- 019_missed_calls.sql
CREATE TABLE IF NOT EXISTS missed_call_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL, vmn_number VARCHAR(15) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    associated_product UUID REFERENCES products(id),
    follow_up_channel VARCHAR(20) DEFAULT 'whatsapp',
    follow_up_template_id UUID REFERENCES whatsapp_templates(id),
    total_calls INTEGER DEFAULT 0, unique_callers INTEGER DEFAULT 0,
    converted_to_farmer INTEGER DEFAULT 0,
    start_date DATE, end_date DATE, created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS missed_call_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES missed_call_campaigns(id),
    phone VARCHAR(15) NOT NULL, telecom_circle VARCHAR(50),
    call_timestamp TIMESTAMPTZ NOT NULL,
    is_existing_farmer BOOLEAN DEFAULT FALSE,
    farmer_id UUID REFERENCES farmers(id),
    follow_up_sent BOOLEAN DEFAULT FALSE, follow_up_channel VARCHAR(20),
    follow_up_timestamp TIMESTAMPTZ,
    onboarding_started BOOLEAN DEFAULT FALSE, onboarding_completed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mc_leads_phone ON missed_call_leads (phone);
CREATE INDEX IF NOT EXISTS idx_mc_leads_campaign ON missed_call_leads (campaign_id);
INSERT INTO _migrations (filename) VALUES ('019_missed_calls.sql') ON CONFLICT DO NOTHING;
