-- =============================================================
-- Migration 016 – audit_log
-- Immutable, append-only audit trail for all system events
-- =============================================================
BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM _migrations WHERE filename = '016_audit_log.sql') THEN
    RAISE EXCEPTION 'Migration 016 already applied';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL PRIMARY KEY,         -- BIGSERIAL for high-volume append
    event_id        UUID NOT NULL DEFAULT gen_random_uuid(),  -- globally unique event ref
    event_type      VARCHAR(60) NOT NULL,
        -- e.g. 'farmer.created','farmer.updated','conversation.started',
        --      'product.verified','admin.login','campaign.sent','referral.rewarded',
        --      'moderation.action','dealer.suspended','consent.revoked'
    entity_type     VARCHAR(40) NOT NULL,           -- 'farmer','product','dealer','admin','campaign','referral'
    entity_id       UUID,                           -- PK of the affected row
    actor_type      VARCHAR(20) NOT NULL DEFAULT 'system',  -- 'farmer','admin','system','webhook','cron'
    actor_id        UUID,                           -- admin or farmer UUID (NULL for system/cron)
    actor_ip        INET,
    actor_user_agent TEXT,
    action          VARCHAR(30) NOT NULL,           -- 'create','update','delete','read','login','export','escalate'
    changes         JSONB,                          -- {field: {old: ..., new: ...}} for updates
    metadata        JSONB,                          -- any extra context
    request_id      UUID,                           -- correlation ID from HTTP/webhook
    service         VARCHAR(40),                    -- 'whatsapp-gateway','intelligence','admin-api','automation'
    severity        VARCHAR(10) NOT NULL DEFAULT 'info',  -- 'debug','info','warn','error','critical'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ─────────────────────────────────────────────────
-- Primary query patterns: by entity, by actor, by event type, by time range
CREATE INDEX idx_audit_entity       ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_actor        ON audit_log (actor_type, actor_id);
CREATE INDEX idx_audit_event_type   ON audit_log (event_type);
CREATE INDEX idx_audit_created      ON audit_log (created_at DESC);
CREATE INDEX idx_audit_severity     ON audit_log (severity) WHERE severity IN ('warn','error','critical');
CREATE INDEX idx_audit_service      ON audit_log (service);
CREATE INDEX idx_audit_request      ON audit_log (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX idx_audit_changes      ON audit_log USING GIN (changes) WHERE changes IS NOT NULL;
CREATE INDEX idx_audit_metadata     ON audit_log USING GIN (metadata) WHERE metadata IS NOT NULL;

-- ── Hypertable conversion (TimescaleDB) for time-series queries ──
-- Partitions by created_at in 7-day chunks; 90-day retention via policy
SELECT create_hypertable(
    'audit_log', 'created_at',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE,
    migrate_data => TRUE
);

SELECT add_retention_policy(
    'audit_log',
    drop_after => INTERVAL '365 days',
    if_not_exists => TRUE
);

-- ── Immutability: prevent UPDATE and DELETE on audit_log ────
CREATE OR REPLACE FUNCTION trg_audit_log_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only. UPDATE and DELETE are prohibited.';
    RETURN NULL;
END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_no_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION trg_audit_log_immutable();

CREATE TRIGGER trg_audit_log_no_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION trg_audit_log_immutable();

-- Note: TimescaleDB retention policy drops entire chunks (not row-level DELETE),
-- so the trigger does not interfere with automated retention.

-- ── Helper: insert audit entry (callable from app code or other triggers) ──
CREATE OR REPLACE FUNCTION fn_audit_insert(
    p_event_type   VARCHAR,
    p_entity_type  VARCHAR,
    p_entity_id    UUID,
    p_actor_type   VARCHAR,
    p_actor_id     UUID,
    p_action       VARCHAR,
    p_changes      JSONB DEFAULT NULL,
    p_metadata     JSONB DEFAULT NULL,
    p_service      VARCHAR DEFAULT NULL,
    p_severity     VARCHAR DEFAULT 'info',
    p_request_id   UUID DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_event_id UUID;
BEGIN
    INSERT INTO audit_log (
        event_type, entity_type, entity_id,
        actor_type, actor_id, action,
        changes, metadata, service, severity, request_id
    ) VALUES (
        p_event_type, p_entity_type, p_entity_id,
        p_actor_type, p_actor_id, p_action,
        p_changes, p_metadata, p_service, p_severity, p_request_id
    ) RETURNING event_id INTO v_event_id;

    RETURN v_event_id;
END;

$$ LANGUAGE plpgsql;

-- ── Migration tracking ──────────────────────────────────────
INSERT INTO _migrations (filename, description, applied_at)
VALUES ('016_audit_log.sql', 'Immutable audit log hypertable, indexes, immutability triggers, helper fn', NOW());

COMMIT;
