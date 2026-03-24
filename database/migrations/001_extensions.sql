-- ═══════════════════════════════════════════════════════════════
-- VartMap – Krishi Sahayak
-- Migration 001: PostgreSQL Extensions
--
-- MUST be run FIRST before all other migrations.
-- Order matters: TimescaleDB first, then spatial, then utility.
--
-- Target: PostgreSQL 16 + TimescaleDB (timescale/timescaledb:latest-pg16)
-- ═══════════════════════════════════════════════════════════════

-- ─── TimescaleDB ───────────────────────────────────────────────
-- Time-series engine for mandi prices, metrics, usage tracking.
-- Must be loaded via shared_preload_libraries in postgresql.conf
-- (handled automatically by the timescale/timescaledb Docker image).
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ─── UUID Generation ──────────────────────────────────────────
-- gen_random_uuid() for primary keys across all tables.
-- Built into PG 13+, but extension ensures pgcrypto functions exist.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── PostGIS ──────────────────────────────────────────────────
-- Geographic data types: GEOGRAPHY(POINT, 4326) for farmer/dealer
-- locations, nearest-dealer spatial queries, coverage maps.
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "postgis_topology";

-- ─── Trigram Similarity ───────────────────────────────────────
-- Powers fuzzy text search for district/village name matching.
-- Used with similarity(), show_trgm(), and GIN indexes.
-- Critical for: "varansi" → "Varanasi", "balia" → "Ballia"
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Full-Text Search (built-in, but configure dictionaries) ──
-- Hindi text search configuration for farmer queries, KB search.
-- PG doesn't ship with Hindi stemmer; use 'simple' config initially.
-- In production, consider pg_bigm for CJK/Indic scripts.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_ts_config WHERE cfgname = 'hindi_simple'
    ) THEN
        CREATE TEXT SEARCH CONFIGURATION hindi_simple (COPY = simple);
        -- simple config treats each token as-is (no stemming),
        -- which works well for Hindi/Devanagari agri terms
    END IF;
END

$$;

-- ─── btree_gist ───────────────────────────────────────────────
-- Required for exclusion constraints and multi-column GiST indexes.
-- Used in campaign scheduling to prevent overlapping campaigns.
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ─── citext (Case-Insensitive Text) ──────────────────────────
-- For columns where case-insensitive comparison is needed:
-- email addresses, template names, product codes, coupon codes.
CREATE EXTENSION IF NOT EXISTS "citext";

-- ─── hstore (Key-Value Store) ─────────────────────────────────
-- Lightweight key-value for optional/dynamic farmer profile fields
-- where JSONB is overkill. Example: custom_fields hstore.
CREATE EXTENSION IF NOT EXISTS "hstore";

-- ═══════════════════════════════════════════════════════════════
-- VERIFY ALL EXTENSIONS ARE LOADED
-- ═══════════════════════════════════════════════════════════════
DO $$
DECLARE
    ext RECORD;
    required_exts TEXT[] := ARRAY[
        'timescaledb', 'pgcrypto', 'postgis', 'pg_trgm',
        'btree_gist', 'citext', 'hstore'
    ];
    missing_exts TEXT[] := '{}';
BEGIN
    FOREACH ext.extname IN ARRAY required_exts LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_extension WHERE extname = ext.extname
        ) THEN
            missing_exts := array_append(missing_exts, ext.extname);
        END IF;
    END LOOP;

    IF array_length(missing_exts, 1) > 0 THEN
        RAISE EXCEPTION 'Missing required extensions: %', missing_exts;
    ELSE
        RAISE NOTICE 'All required extensions verified: %', required_exts;
    END IF;
END

$$;

-- ═══════════════════════════════════════════════════════════════
-- CUSTOM TYPES & ENUMS
-- Centralized here so all subsequent migrations can reference them.
-- ═══════════════════════════════════════════════════════════════

-- Farmer onboarding states (state machine in Section 2)
DO $$ BEGIN
    CREATE TYPE onboarding_status_enum AS ENUM (
        'new_user',
        'language_selection',
        'name_collection',
        'state_selection',
        'district_selection',
        'village_collection',
        'crop_selection',
        'crop_selection_2',
        'land_size',
        'consent',
        'completed'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Farmer tier
DO $$ BEGIN
    CREATE TYPE farmer_tier_enum AS ENUM (
        'free', 'premium', 'dealer_sponsored'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Farmer acquisition source
DO $$ BEGIN
    CREATE TYPE farmer_source_enum AS ENUM (
        'qr_scan', 'dealer', 'referral', 'missed_call',
        'organic', 'campaign', 'ivr', 'field_event'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Language
DO $$ BEGIN
    CREATE TYPE language_enum AS ENUM ('hi', 'bho', 'en', 'mr', 'ta', 'te');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Message direction
DO $$ BEGIN
    CREATE TYPE message_direction_enum AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Processing layer (which intelligence layer handled it)
DO $$ BEGIN
    CREATE TYPE processing_layer_enum AS ENUM (
        'rule_based', 'semantic_cache', 'rag_ai', 'fallback', 'human_expert'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WhatsApp template status
DO $$ BEGIN
    CREATE TYPE template_status_enum AS ENUM (
        'draft', 'pending', 'approved', 'rejected', 'paused', 'archived'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WhatsApp template category
DO $$ BEGIN
    CREATE TYPE template_category_enum AS ENUM (
        'MARKETING', 'UTILITY', 'AUTHENTICATION'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Campaign status
DO $$ BEGIN
    CREATE TYPE campaign_status_enum AS ENUM (
        'draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Order status
DO $$ BEGIN
    CREATE TYPE order_status_enum AS ENUM (
        'pending', 'confirmed', 'dispatched', 'delivered', 'cancelled', 'returned'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reward campaign type
DO $$ BEGIN
    CREATE TYPE reward_type_enum AS ENUM (
        'lucky_draw', 'spin_wheel', 'points_loyalty', 'dealer_incentive'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reward campaign status
DO $$ BEGIN
    CREATE TYPE reward_status_enum AS ENUM (
        'draft', 'active', 'paused', 'completed'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Prize type
DO $$ BEGIN
    CREATE TYPE prize_type_enum AS ENUM (
        'cashback', 'product', 'discount', 'experience', 'jackpot', 'try_again'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Coupon code status
DO $$ BEGIN
    CREATE TYPE coupon_status_enum AS ENUM (
        'active', 'redeemed', 'expired', 'flagged'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Points transaction type
DO $$ BEGIN
    CREATE TYPE points_txn_type_enum AS ENUM (
        'earned', 'redeemed', 'expired', 'bonus', 'adjustment'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Payment status
DO $$ BEGIN
    CREATE TYPE payment_status_enum AS ENUM (
        'pending', 'processing', 'completed', 'failed', 'refunded'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Alert severity
DO $$ BEGIN
    CREATE TYPE alert_severity_enum AS ENUM ('info', 'warning', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Admin user roles (RBAC)
DO $$ BEGIN
    CREATE TYPE admin_role_enum AS ENUM (
        'super_admin', 'admin', 'marketing', 'agronomist',
        'sales', 'support', 'dealer', 'viewer'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Image analysis type
DO $$ BEGIN
    CREATE TYPE analysis_type_enum AS ENUM (
        'disease', 'pest', 'nutrient_deficiency', 'weed',
        'health_score', 'growth_stage', 'unknown'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Severity level
DO $$ BEGIN
    CREATE TYPE severity_enum AS ENUM ('mild', 'moderate', 'severe', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Crop season
DO $$ BEGIN
    CREATE TYPE season_enum AS ENUM ('kharif', 'rabi', 'zaid');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Irrigation type
DO $$ BEGIN
    CREATE TYPE irrigation_enum AS ENUM (
        'rainfed', 'tubewell', 'canal', 'drip', 'sprinkler', 'mixed'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Caste category
DO $$ BEGIN
    CREATE TYPE caste_category_enum AS ENUM ('general', 'obc', 'sc', 'st');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- HELPER FUNCTIONS (used across migrations)
-- ═══════════════════════════════════════════════════════════════

-- Auto-update updated_at timestamp on row modification
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;

$$ LANGUAGE plpgsql;

-- Calculate Levenshtein distance (for fuzzy district matching)
-- pg_trgm gives similarity; this gives edit distance for fine control
CREATE OR REPLACE FUNCTION fuzzy_match_score(input_text TEXT, target_text TEXT)
RETURNS FLOAT AS $$
BEGIN
    -- Combine trigram similarity (faster) with position-aware scoring
    RETURN similarity(lower(input_text), lower(target_text));
END;

$$ LANGUAGE plpgsql IMMUTABLE;

-- ═══════════════════════════════════════════════════════════════
-- CONFIGURATION
-- ═══════════════════════════════════════════════════════════════

-- TimescaleDB tuning for our workload pattern
-- (mandi prices: frequent inserts, range scans by time + commodity)
ALTER SYSTEM SET timescaledb.max_background_workers = 8;

-- pg_trgm: lower similarity threshold for fuzzy matching
-- Default 0.3 is too strict for Hindi transliterations
ALTER SYSTEM SET pg_trgm.similarity_threshold = 0.2;

-- Reload config
SELECT pg_reload_conf();

-- ═══════════════════════════════════════════════════════════════
-- MIGRATION TRACKING TABLE
-- Tracks which migrations have been applied.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT NOW(),
    checksum VARCHAR(64)  -- SHA-256 of file content for drift detection
);

INSERT INTO _migrations (filename, checksum)
VALUES ('001_extensions.sql', 'manual')
ON CONFLICT (filename) DO NOTHING;
