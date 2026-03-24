-- =============================================================
-- Migration 015 – crop_calendar
-- Regional crop calendar templates + farmer-specific schedules
-- =============================================================
BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM _migrations WHERE filename = '015_crop_calendar.sql') THEN
    RAISE EXCEPTION 'Migration 015 already applied';
  END IF;
END $$;

-- ── Master calendar templates (admin-managed) ───────────────
CREATE TABLE IF NOT EXISTS crop_calendar_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    crop_name       VARCHAR(100) NOT NULL,
    crop_name_local VARCHAR(100),                  -- Hindi / regional name
    variety         VARCHAR(100),
    season          VARCHAR(20) NOT NULL,           -- 'kharif','rabi','zaid','perennial'
    state_code      VARCHAR(5),                     -- NULL = all-India
    agro_zone       VARCHAR(60),                    -- ICAR agro-climatic zone
    soil_types      TEXT[],                         -- e.g. {'alluvial','black','red'}
    stages          JSONB NOT NULL,
        -- [{stage:'land_prep', start_doy:150, end_doy:165, advisory:'...', inputs:[...]}, ...]
    total_duration_days INTEGER,
    source          VARCHAR(120),                  -- 'ICAR','KVK-Varanasi','state-agri-dept'
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    version         INTEGER NOT NULL DEFAULT 1,
    created_by      UUID,                          -- admin user
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cct_crop        ON crop_calendar_templates (crop_name);
CREATE INDEX idx_cct_season      ON crop_calendar_templates (season);
CREATE INDEX idx_cct_state       ON crop_calendar_templates (state_code);
CREATE INDEX idx_cct_zone        ON crop_calendar_templates (agro_zone);
CREATE INDEX idx_cct_stages      ON crop_calendar_templates USING GIN (stages);
CREATE INDEX idx_cct_active      ON crop_calendar_templates (is_active) WHERE is_active = TRUE;

-- ── Farmer-specific calendar instances ──────────────────────
CREATE TABLE IF NOT EXISTS farmer_crop_calendar (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id       UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    template_id     UUID REFERENCES crop_calendar_templates(id) ON DELETE SET NULL,
    crop_name       VARCHAR(100) NOT NULL,
    season          VARCHAR(20) NOT NULL,
    year            SMALLINT NOT NULL,
    sowing_date     DATE,
    expected_harvest DATE,
    current_stage   VARCHAR(60),
    stages_log      JSONB NOT NULL DEFAULT '[]'::JSONB,
        -- [{stage, started_at, completed_at, notes, advisory_sent}]
    field_area_acres NUMERIC(8,2),
    location        GEOGRAPHY(Point, 4326),
    reminders_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    next_reminder_at  TIMESTAMPTZ,
    status          VARCHAR(20) NOT NULL DEFAULT 'active',  -- 'active','completed','abandoned'
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fcc_farmer        ON farmer_crop_calendar (farmer_id);
CREATE INDEX idx_fcc_crop_season   ON farmer_crop_calendar (crop_name, season, year);
CREATE INDEX idx_fcc_template      ON farmer_crop_calendar (template_id);
CREATE INDEX idx_fcc_status        ON farmer_crop_calendar (status) WHERE status = 'active';
CREATE INDEX idx_fcc_reminder      ON farmer_crop_calendar (next_reminder_at)
    WHERE reminders_enabled = TRUE AND status = 'active';
CREATE INDEX idx_fcc_location      ON farmer_crop_calendar USING GIST (location);
CREATE INDEX idx_fcc_stages_log    ON farmer_crop_calendar USING GIN (stages_log);

-- ── Crop calendar reminders sent (audit trail) ──────────────
CREATE TABLE IF NOT EXISTS crop_calendar_reminders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    calendar_id     UUID NOT NULL REFERENCES farmer_crop_calendar(id) ON DELETE CASCADE,
    farmer_id       UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    stage           VARCHAR(60) NOT NULL,
    reminder_type   VARCHAR(30) NOT NULL,           -- 'stage_start','input_reminder','weather_alert','harvest_prep'
    message_id      VARCHAR(80),                    -- WhatsApp message ID
    channel         VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
    delivered       BOOLEAN NOT NULL DEFAULT FALSE,
    read_at         TIMESTAMPTZ,
    actioned        BOOLEAN NOT NULL DEFAULT FALSE,  -- farmer acknowledged / responded
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ccr_calendar   ON crop_calendar_reminders (calendar_id);
CREATE INDEX idx_ccr_farmer     ON crop_calendar_reminders (farmer_id);
CREATE INDEX idx_ccr_sent       ON crop_calendar_reminders (sent_at DESC);

-- ── Triggers ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_cct_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_crop_cal_template_updated
    BEFORE UPDATE ON crop_calendar_templates
    FOR EACH ROW EXECUTE FUNCTION trg_cct_updated_at();

CREATE OR REPLACE FUNCTION trg_fcc_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;

$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_farmer_crop_cal_updated
    BEFORE UPDATE ON farmer_crop_calendar
    FOR EACH ROW EXECUTE FUNCTION trg_fcc_updated_at();

-- ── Migration tracking ──────────────────────────────────────
INSERT INTO _migrations (filename, description, applied_at)
VALUES ('015_crop_calendar.sql', 'Crop calendar templates, farmer instances, reminders, triggers', NOW());

COMMIT;
