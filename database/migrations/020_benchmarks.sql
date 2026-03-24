-- 020_benchmarks.sql
CREATE TABLE IF NOT EXISTS performance_benchmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(20) NOT NULL, entity_id UUID NOT NULL,
    period_start DATE NOT NULL, period_end DATE NOT NULL,
    metrics JSONB NOT NULL,
    rank_in_group INTEGER, group_size INTEGER, percentile DECIMAL(5,2),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO _migrations (filename) VALUES ('020_benchmarks.sql') ON CONFLICT DO NOTHING;
