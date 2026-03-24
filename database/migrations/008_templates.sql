-- 008_templates.sql
CREATE TABLE IF NOT EXISTS whatsapp_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    category template_category_enum NOT NULL,
    language VARCHAR(5) NOT NULL DEFAULT 'hi',
    status template_status_enum DEFAULT 'draft',
    header_type VARCHAR(10),
    header_content TEXT,
    body_text TEXT NOT NULL,
    footer_text TEXT,
    buttons JSONB,
    variables JSONB,
    meta_template_id VARCHAR(50),
    rejection_reason TEXT,
    version INTEGER DEFAULT 1,
    quality_score DECIMAL(4,2),
    times_sent INTEGER DEFAULT 0,
    delivery_rate DECIMAL(5,2),
    read_rate DECIMAL(5,2),
    click_rate DECIMAL(5,2),
    block_rate DECIMAL(5,2),
    cost_per_send DECIMAL(6,4),
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TRIGGER set_templates_updated_at BEFORE UPDATE ON whatsapp_templates FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
INSERT INTO _migrations (filename) VALUES ('008_templates.sql') ON CONFLICT DO NOTHING;
