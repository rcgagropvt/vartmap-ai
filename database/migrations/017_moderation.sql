-- =============================================================
-- Migration 017 – moderation
-- Content moderation queue, actions, appeals, and auto-detection
-- =============================================================
BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM _migrations WHERE filename = '017_moderation.sql') THEN
    RAISE EXCEPTION 'Migration 017 already applied';
  END IF;
END $$;

-- ── Moderation queue (flagged content awaiting review) ──────
CREATE TABLE IF NOT EXISTS moderation_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id       UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    message_id      VARCHAR(80),                    -- WhatsApp message ID
    content_type    VARCHAR(20) NOT NULL,            -- 'text','image','audio','video','document','location'
    content_text    TEXT,                            -- original text (or transcription)
    content_url     TEXT,                            -- media URL if applicable
    content_hash    VARCHAR(64),                     -- SHA-256 for duplicate detection

    -- Detection details
    detection_method VARCHAR(30) NOT NULL,
        -- 'keyword_filter','ai_classifier','user_report','admin_flag','spam_detector','image_scan'
    detection_score  NUMERIC(5,4),                   -- 0.0000 to 1.0000 confidence
    detection_labels TEXT[],                          -- e.g. {'spam','profanity','misinformation','harmful_content'}
    detection_metadata JSONB,                        -- model version, thresholds, matched keywords, etc.

    -- Queue management
    priority        SMALLINT NOT NULL DEFAULT 5,     -- 1 (critical) to 10 (low)
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
        -- 'pending','in_review','resolved','escalated','auto_resolved','expired'
    assigned_to     UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    assigned_at     TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    sla_deadline    TIMESTAMPTZ,                     -- auto-set based on priority

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX idx_modq_status         ON moderation_queue (status) WHERE status IN ('pending','in_review','escalated');
CREATE INDEX idx_modq_farmer         ON moderation_queue (farmer_id);
CREATE INDEX idx_modq_priority       ON moderation_queue (priority ASC, created_at ASC) WHERE status = 'pending';
CREATE INDEX idx_modq_assigned       ON moderation_queue (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_modq_created        ON moderation_queue (created_at DESC);
CREATE INDEX idx_modq_detection      ON moderation_queue (detection_method);
CREATE INDEX idx_modq_labels         ON moderation_queue USING GIN (detection_labels);
CREATE INDEX idx_modq_content_hash   ON moderation_queue (content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX idx_modq_sla            ON moderation_queue (sla_deadline) WHERE status IN ('pending','in_review');
CREATE INDEX idx_modq_conversation   ON moderation_queue (conversation_id) WHERE conversation_id IS NOT NULL;

-- ── Moderation actions (every action taken on a queue item) ─
CREATE TABLE IF NOT EXISTS moderation_actions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue_id        UUID NOT NULL REFERENCES moderation_queue(id) ON DELETE CASCADE,
    admin_id        UUID REFERENCES admin_users(id) ON DELETE SET NULL,  -- NULL for auto-actions
    action_type     VARCHAR(30) NOT NULL,
        -- 'approve','reject','delete_content','warn_user','mute_user','ban_user',
        -- 'escalate','auto_approve','auto_reject','request_info','restore'
    reason          TEXT,
    policy_reference VARCHAR(60),                    -- e.g. 'POLICY-SPAM-001','POLICY-MISINFO-003'
    duration_hours  INTEGER,                         -- for mute/ban: how long
    expires_at      TIMESTAMPTZ,                     -- when a mute/ban expires
    notified_farmer BOOLEAN NOT NULL DEFAULT FALSE,  -- was the farmer notified of this action?
    notification_message_id VARCHAR(80),
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_modact_queue     ON moderation_actions (queue_id);
CREATE INDEX idx_modact_admin     ON moderation_actions (admin_id) WHERE admin_id IS NOT NULL;
CREATE INDEX idx_modact_type      ON moderation_actions (action_type);
CREATE INDEX idx_modact_created   ON moderation_actions (created_at DESC);
CREATE INDEX idx_modact_expires   ON moderation_actions (expires_at) WHERE expires_at IS NOT NULL;

-- ── Moderation appeals ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS moderation_appeals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue_id        UUID NOT NULL REFERENCES moderation_queue(id) ON DELETE CASCADE,
    farmer_id       UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    action_id       UUID NOT NULL REFERENCES moderation_actions(id) ON DELETE CASCADE,
    appeal_text     TEXT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'submitted',
        -- 'submitted','under_review','upheld','overturned','withdrawn'
    reviewed_by     UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    review_notes    TEXT,
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_modappeal_queue    ON moderation_appeals (queue_id);
CREATE INDEX idx_modappeal_farmer   ON moderation_appeals (farmer_id);
CREATE INDEX idx_modappeal_status   ON moderation_appeals (status) WHERE status IN ('submitted','under_review');
CREATE INDEX idx_modappeal_created  ON moderation_appeals (created_at DESC);

-- ── Farmer moderation state (current restrictions) ──────────
CREATE TABLE IF NOT EXISTS farmer_moderation_status (
    farmer_id       UUID PRIMARY KEY REFERENCES farmers(id) ON DELETE CASCADE,
    is_muted        BOOLEAN NOT NULL DEFAULT FALSE,
    muted_until     TIMESTAMPTZ,
    is_banned       BOOLEAN NOT NULL DEFAULT FALSE,
    banned_until    TIMESTAMPTZ,                     -- NULL = permanent
    warning_count   INTEGER NOT NULL DEFAULT 0,
    total_violations INTEGER NOT NULL DEFAULT 0,
    trust_score     NUMERIC(5,4) NOT NULL DEFAULT 1.0000,  -- 0 to 1; decays with violations
    last_violation_at TIMESTAMPTZ,
    last_reviewed_at  TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fms_muted   ON farmer_moderation_status (is_muted) WHERE is_muted = TRUE;
CREATE INDEX idx_fms_banned  ON farmer_moderation_status (is_banned) WHERE is_banned = TRUE;
CREATE INDEX idx_fms_trust   ON farmer_moderation_status (trust_score ASC);

-- ── Triggers ────────────────────────────────────────────────

-- 1. Auto-set SLA deadline on moderation_queue insert based on priority
CREATE OR REPLACE FUNCTION trg_modq_set_sla()
RETURNS TRIGGER AS $$
BEGIN
    NEW.sla_deadline := CASE
        WHEN NEW.priority <= 2 THEN NOW() + INTERVAL '1 hour'
        WHEN NEW.priority <= 5 THEN NOW() + INTERVAL '4 hours'
        WHEN NEW.priority <= 7 THEN NOW() + INTERVAL '24 hours'
        ELSE NOW() + INTERVAL '72 hours'
    END;
    RETURN NEW;
END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_moderation_queue_sla
    BEFORE INSERT ON moderation_queue
    FOR EACH ROW
    WHEN (NEW.sla_deadline IS NULL)
    EXECUTE FUNCTION trg_modq_set_sla();

-- 2. updated_at triggers
CREATE OR REPLACE FUNCTION trg_modq_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_moderation_queue_updated
    BEFORE UPDATE ON moderation_queue
    FOR EACH ROW EXECUTE FUNCTION trg_modq_updated_at();

CREATE OR REPLACE FUNCTION trg_modappeal_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_moderation_appeal_updated
    BEFORE UPDATE ON moderation_appeals
    FOR EACH ROW EXECUTE FUNCTION trg_modappeal_updated_at();

CREATE OR REPLACE FUNCTION trg_fms_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_farmer_mod_status_updated
    BEFORE UPDATE ON farmer_moderation_status
    FOR EACH ROW EXECUTE FUNCTION trg_fms_updated_at();

-- 3. Auto-increment violation count when a punitive action is taken
CREATE OR REPLACE FUNCTION trg_modact_update_farmer_status()
RETURNS TRIGGER AS $$
DECLARE
    v_farmer_id UUID;
BEGIN
    -- Get the farmer from the queue item
    SELECT farmer_id INTO v_farmer_id
      FROM moderation_queue WHERE id = NEW.queue_id;

    IF v_farmer_id IS NULL THEN RETURN NEW; END IF;

    -- Upsert farmer_moderation_status
    INSERT INTO farmer_moderation_status (farmer_id, total_violations, warning_count,
                                          is_muted, muted_until, is_banned, banned_until,
                                          last_violation_at, trust_score)
    VALUES (
        v_farmer_id,
        CASE WHEN NEW.action_type IN ('warn_user','mute_user','ban_user','reject','delete_content') THEN 1 ELSE 0 END,
        CASE WHEN NEW.action_type = 'warn_user' THEN 1 ELSE 0 END,
        NEW.action_type = 'mute_user',
        NEW.expires_at,
        NEW.action_type = 'ban_user',
        NEW.expires_at,
        CASE WHEN NEW.action_type IN ('warn_user','mute_user','ban_user','reject') THEN NOW() ELSE NULL END,
        0.9000
    )
    ON CONFLICT (farmer_id) DO UPDATE SET
        total_violations = farmer_moderation_status.total_violations +
            CASE WHEN NEW.action_type IN ('warn_user','mute_user','ban_user','reject','delete_content') THEN 1 ELSE 0 END,
        warning_count = farmer_moderation_status.warning_count +
            CASE WHEN NEW.action_type = 'warn_user' THEN 1 ELSE 0 END,
        is_muted = CASE WHEN NEW.action_type = 'mute_user' THEN TRUE
                        WHEN NEW.action_type = 'restore' THEN FALSE
                        ELSE farmer_moderation_status.is_muted END,
        muted_until = CASE WHEN NEW.action_type = 'mute_user' THEN NEW.expires_at
                           ELSE farmer_moderation_status.muted_until END,
        is_banned = CASE WHEN NEW.action_type = 'ban_user' THEN TRUE
                         WHEN NEW.action_type = 'restore' THEN FALSE
                         ELSE farmer_moderation_status.is_banned END,
        banned_until = CASE WHEN NEW.action_type = 'ban_user' THEN NEW.expires_at
                            ELSE farmer_moderation_status.banned_until END,
        last_violation_at = CASE WHEN NEW.action_type IN ('warn_user','mute_user','ban_user','reject')
                                 THEN NOW() ELSE farmer_moderation_status.last_violation_at END,
        trust_score = GREATEST(0, farmer_moderation_status.trust_score -
            CASE NEW.action_type
                WHEN 'warn_user' THEN 0.05
                WHEN 'mute_user' THEN 0.15
                WHEN 'ban_user' THEN 0.50
                WHEN 'reject' THEN 0.03
                WHEN 'restore' THEN -0.10  -- restore adds back some trust
                ELSE 0
            END),
        updated_at = NOW();

    RETURN NEW;
END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_moderation_action_status_sync
    AFTER INSERT ON moderation_actions
    FOR EACH ROW EXECUTE FUNCTION trg_modact_update_farmer_status();

-- ── Migration tracking ──────────────────────────────────────
INSERT INTO _migrations (filename, description, applied_at)
VALUES ('017_moderation.sql', 'Moderation queue, actions, appeals, farmer status, SLA & status-sync triggers', NOW());

COMMIT;
