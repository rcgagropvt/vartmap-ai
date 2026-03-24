-- =============================================================
-- Migration 014 – referrals
-- Farmer-to-farmer referral programme with multi-level tracking
-- =============================================================
BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM _migrations WHERE filename = '014_referrals.sql') THEN
    RAISE EXCEPTION 'Migration 014 already applied';
  END IF;
END $$;

-- ── Referral codes (one per farmer) ─────────────────────────
CREATE TABLE IF NOT EXISTS referral_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id       UUID NOT NULL UNIQUE REFERENCES farmers(id) ON DELETE CASCADE,
    code            VARCHAR(12) NOT NULL UNIQUE,     -- e.g. 'KRISHI-A7X2'
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    max_uses        INTEGER NOT NULL DEFAULT 50,
    total_uses      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refcode_code     ON referral_codes (code);
CREATE INDEX idx_refcode_farmer   ON referral_codes (farmer_id);

-- ── Referral events ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_code_id    UUID NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
    referrer_id         UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    referee_id          UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
        -- 'pending','onboarded','qualified','rewarded','expired','fraudulent'
    referee_onboarded_at TIMESTAMPTZ,
    qualified_at        TIMESTAMPTZ,       -- referee completed N interactions
    qualification_criteria JSONB,          -- snapshot of what was checked
    reward_type         VARCHAR(30),       -- 'points','badge','free_query','cashback'
    reward_value        NUMERIC(10,2) DEFAULT 0,
    referrer_rewarded   BOOLEAN NOT NULL DEFAULT FALSE,
    referee_rewarded    BOOLEAN NOT NULL DEFAULT FALSE,
    fraud_flags         JSONB,             -- auto-detection signals
    channel             VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_referral_pair UNIQUE (referrer_id, referee_id)
);

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX idx_ref_referrer        ON referrals (referrer_id);
CREATE INDEX idx_ref_referee         ON referrals (referee_id);
CREATE INDEX idx_ref_status          ON referrals (status);
CREATE INDEX idx_ref_created         ON referrals (created_at DESC);
CREATE INDEX idx_ref_code            ON referrals (referral_code_id);
CREATE INDEX idx_ref_qualified       ON referrals (qualified_at) WHERE qualified_at IS NOT NULL;
CREATE INDEX idx_ref_fraud           ON referrals USING GIN (fraud_flags) WHERE fraud_flags IS NOT NULL;

-- ── Referral rewards ledger (immutable log) ─────────────────
CREATE TABLE IF NOT EXISTS referral_rewards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_id     UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
    farmer_id       UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    role            VARCHAR(10) NOT NULL CHECK (role IN ('referrer','referee')),
    reward_type     VARCHAR(30) NOT NULL,
    reward_value    NUMERIC(10,2) NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'credited',  -- 'credited','redeemed','reversed'
    credited_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    redeemed_at     TIMESTAMPTZ,
    reversed_at     TIMESTAMPTZ,
    metadata        JSONB
);

CREATE INDEX idx_refreward_farmer  ON referral_rewards (farmer_id);
CREATE INDEX idx_refreward_ref     ON referral_rewards (referral_id);

-- ── Triggers ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_referral_codes_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_referral_codes_set_updated_at
    BEFORE UPDATE ON referral_codes
    FOR EACH ROW EXECUTE FUNCTION trg_referral_codes_updated_at();

CREATE OR REPLACE FUNCTION trg_referrals_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_referrals_set_updated_at
    BEFORE UPDATE ON referrals
    FOR EACH ROW EXECUTE FUNCTION trg_referrals_updated_at();

-- Auto-increment total_uses on referral_codes when a referral is inserted
CREATE OR REPLACE FUNCTION trg_referral_increment_uses()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE referral_codes
       SET total_uses = total_uses + 1,
           updated_at = NOW()
     WHERE id = NEW.referral_code_id;
    RETURN NEW;
END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_referral_inc_uses
    AFTER INSERT ON referrals
    FOR EACH ROW EXECUTE FUNCTION trg_referral_increment_uses();

-- ── Migration tracking ──────────────────────────────────────
INSERT INTO _migrations (filename, description, applied_at)
VALUES ('014_referrals.sql', 'Referral codes, referrals, rewards ledger, triggers', NOW());

COMMIT;
