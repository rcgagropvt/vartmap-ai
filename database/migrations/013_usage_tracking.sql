-- =============================================================
-- Migration 013 – usage_tracking
-- Tracks per-farmer daily / monthly API & feature usage
-- =============================================================
BEGIN;

-- Guard: skip if already applied
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM _migrations WHERE filename = '013_usage_tracking.sql') THEN
    RAISE EXCEPTION 'Migration 013 already applied';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS usage_tracking (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id       UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    feature         VARCHAR(60) NOT NULL,          -- e.g. 'mandi_price','weather','ai_query','image_analysis','spray_advisory'
    channel         VARCHAR(20) NOT NULL DEFAULT 'whatsapp',  -- 'whatsapp','ivr','ussd','web'
    tokens_used     INTEGER NOT NULL DEFAULT 0,     -- LLM tokens consumed (0 for rule-based)
    cost_inr        NUMERIC(10,4) NOT NULL DEFAULT 0.0000,
    latency_ms      INTEGER,                        -- end-to-end response time
    cache_hit       BOOLEAN NOT NULL DEFAULT FALSE,
    request_payload JSONB,                          -- optional: stripped/hashed input for debugging
    response_status VARCHAR(20) NOT NULL DEFAULT 'success',  -- 'success','error','timeout','rate_limited'
    error_code      VARCHAR(40),
    session_id      UUID,                           -- links to conversations.id if applicable
    ip_or_device    VARCHAR(80),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX idx_usage_farmer          ON usage_tracking (farmer_id);
CREATE INDEX idx_usage_feature         ON usage_tracking (feature);
CREATE INDEX idx_usage_created         ON usage_tracking (created_at DESC);
CREATE INDEX idx_usage_farmer_feature  ON usage_tracking (farmer_id, feature, created_at DESC);
CREATE INDEX idx_usage_channel         ON usage_tracking (channel);
CREATE INDEX idx_usage_status          ON usage_tracking (response_status) WHERE response_status != 'success';
CREATE INDEX idx_usage_cost            ON usage_tracking (cost_inr DESC) WHERE cost_inr > 0;

-- ── Daily aggregate materialized view (refresh via cron / pg_cron) ──
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_usage_daily AS
SELECT
    date_trunc('day', created_at)::DATE AS usage_date,
    farmer_id,
    feature,
    channel,
    COUNT(*)                            AS request_count,
    SUM(tokens_used)                    AS total_tokens,
    SUM(cost_inr)                       AS total_cost_inr,
    AVG(latency_ms)::INTEGER            AS avg_latency_ms,
    COUNT(*) FILTER (WHERE cache_hit)   AS cache_hits,
    COUNT(*) FILTER (WHERE response_status != 'success') AS error_count
FROM usage_tracking
GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX idx_mv_usage_daily_pk
    ON mv_usage_daily (usage_date, farmer_id, feature, channel);

-- ── Auto-update updated_at ──────────────────────────────────
CREATE OR REPLACE FUNCTION trg_usage_tracking_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_usage_tracking_set_updated_at
    BEFORE UPDATE ON usage_tracking
    FOR EACH ROW EXECUTE FUNCTION trg_usage_tracking_updated_at();

-- ── Migration tracking ──────────────────────────────────────
INSERT INTO _migrations (filename, description, applied_at)
VALUES ('013_usage_tracking.sql', 'Usage tracking table, indexes, daily MV, trigger', NOW());

COMMIT;
