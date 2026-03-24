-- 021_reports_alerts.sql
CREATE TABLE IF NOT EXISTS analytics_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL, type VARCHAR(30),
    filters JSONB, metrics JSONB, schedule VARCHAR(20),
    recipients JSONB, last_generated_at TIMESTAMPTZ, file_url TEXT,
    created_by UUID, created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    condition_type VARCHAR(50) NOT NULL,
    condition_params JSONB NOT NULL,
    severity alert_severity_enum DEFAULT 'warning',
    notification_channels TEXT[],
    recipients JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    last_triggered_at TIMESTAMPTZ, trigger_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO _migrations (filename) VALUES ('021_reports_alerts.sql') ON CONFLICT DO NOTHING;
