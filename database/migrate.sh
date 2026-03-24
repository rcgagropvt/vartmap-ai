#!/usr/bin/env bash
# database/migrate.sh
# Applies all SQL migrations in order, skipping those already recorded in _migrations.
# Usage: DATABASE_URL=postgresql://... ./migrate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${SCRIPT_DIR}/migrations"
DB_URL="${DATABASE_URL:?DATABASE_URL environment variable is required}"

echo "╔══════════════════════════════════════════════╗"
echo "║   VartMap Database Migration Runner          ║"
echo "╚══════════════════════════════════════════════╝"
echo "Database: ${DB_URL%%@*}@****"
echo "Migrations directory: ${MIGRATIONS_DIR}"
echo ""

# Ensure _migrations table exists (created in 001_extensions.sql,
# but this is a safety net for first-run bootstrapping)
psql "${DB_URL}" -q -c "
CREATE TABLE IF NOT EXISTS _migrations (
    id         SERIAL PRIMARY KEY,
    filename   VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
" 2>/dev/null || true

APPLIED=0
SKIPPED=0
FAILED=0

for migration_file in "${MIGRATIONS_DIR}"/*.sql; do
    filename="$(basename "${migration_file}")"

    # Check if already applied
    already=$(psql "${DB_URL}" -Atc "SELECT COUNT(*) FROM _migrations WHERE filename='${filename}';" 2>/dev/null || echo "0")

    if [ "${already}" -gt 0 ]; then
        echo "  ⏭  ${filename} (already applied)"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    echo "  ▶  Applying ${filename} ..."
    if psql "${DB_URL}" -v ON_ERROR_STOP=1 -f "${migration_file}"; then
        echo "  ✅ ${filename} applied successfully"
        APPLIED=$((APPLIED + 1))
    else
        echo "  ❌ ${filename} FAILED"
        FAILED=$((FAILED + 1))
        echo ""
        echo "Migration halted. Fix the error and re-run."
        exit 1
    fi
done

echo ""
echo "────────────────────────────────────────────────"
echo "Applied: ${APPLIED}   Skipped: ${SKIPPED}   Failed: ${FAILED}"
echo "────────────────────────────────────────────────"

if [ "${APPLIED}" -gt 0 ]; then
    echo ""
    echo "Running seed loader..."
    cd "${SCRIPT_DIR}"
    python3 seed_loader.py
fi

echo ""
echo "Migration complete."
