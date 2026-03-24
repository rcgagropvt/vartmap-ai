-- ═══════════════════════════════════════════════════════════════
-- Migration 004: Conversations + Image Analyses
-- Every message and analysis is logged (audit trail requirement).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    wa_message_id VARCHAR(100) UNIQUE,
    direction message_direction_enum NOT NULL,
    message_type VARCHAR(20) NOT NULL,     -- text, image, audio, interactive, template, etc.
    content_text TEXT,
    media_url TEXT,
    media_type VARCHAR(20),
    template_name VARCHAR(100),
    template_category template_category_enum,
    intent_detected VARCHAR(50),           -- mandi_price, weather, soil_health, etc.
    processing_layer processing_layer_enum,
    ai_model_used VARCHAR(30),
    ai_tokens_input INTEGER,
    ai_tokens_output INTEGER,
    ai_cost_usd DECIMAL(8,6),
    response_time_ms INTEGER,
    language language_enum,
    farmer_feedback VARCHAR(20),           -- positive, negative, neutral
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_farmer
    ON conversations (farmer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_created
    ON conversations (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_intent
    ON conversations (intent_detected, created_at DESC);

-- ─── Image Analyses ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS image_analyses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    farmer_id UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id),
    image_url TEXT NOT NULL,
    image_url_compressed TEXT,
    crop_name VARCHAR(50),
    analysis_type analysis_type_enum,
    result_primary VARCHAR(100),
    result_secondary VARCHAR(100),
    confidence DECIMAL(4,3) CHECK (confidence >= 0 AND confidence <= 1),
    severity severity_enum,
    affected_area_pct DECIMAL(5,2),
    recommended_action TEXT,
    products_recommended JSONB,            -- [{product_id, name, dosage}]
    model_used VARCHAR(30),
    processing_time_ms INTEGER,
    is_follow_up BOOLEAN DEFAULT FALSE,
    parent_analysis_id UUID REFERENCES image_analyses(id),
    farmer_feedback VARCHAR(20),
    gps_lat DECIMAL(9,6),
    gps_lng DECIMAL(9,6),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_image_analyses_farmer
    ON image_analyses (farmer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_image_analyses_disease
    ON image_analyses (result_primary, created_at DESC);

-- For disease outbreak detection: count by district + disease in 48h window
CREATE INDEX IF NOT EXISTS idx_image_analyses_outbreak
    ON image_analyses (crop_name, result_primary, created_at DESC);

INSERT INTO _migrations (filename) VALUES ('004_conversations.sql')
ON CONFLICT (filename) DO NOTHING;
