-- 009_campaigns.sql
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20),
    template_id UUID REFERENCES whatsapp_templates(id),
    segment_criteria JSONB,
    estimated_reach INTEGER,
    actual_sent INTEGER DEFAULT 0,
    delivered INTEGER DEFAULT 0,
    read_count INTEGER DEFAULT 0,
    replied INTEGER DEFAULT 0,
    clicked INTEGER DEFAULT 0,
    converted INTEGER DEFAULT 0,
    total_cost DECIMAL(10,2) DEFAULT 0,
    budget_limit DECIMAL(10,2),
    status campaign_status_enum DEFAULT 'draft',
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TRIGGER set_campaigns_updated_at BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
INSERT INTO _migrations (filename) VALUES ('009_campaigns.sql') ON CONFLICT DO NOTHING;
