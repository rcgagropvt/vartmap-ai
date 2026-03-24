import os
import psycopg2

# Replace YOUR-PASSWORD with your actual Supabase database password
DB_URL = "postgresql://postgres:Vartmaanfertilizers##1920@db.acqqcdgmruznxxretzow.supabase.co:5432/postgres"

MIGRATIONS_DIR = "database/migrations"

SKIP_KEYWORDS = [
    "timescaledb",
    "create_hypertable",
    "add_retention_policy",
]

def should_skip(line):
    lower = line.strip().lower()
    for kw in SKIP_KEYWORDS:
        if kw in lower:
            return True
    return False

def run():
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    cur = conn.cursor()

    # Create migrations table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS _migrations (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            applied_at TIMESTAMPTZ DEFAULT now()
        );
    """)

    # Get applied
    cur.execute("SELECT name FROM _migrations;")
    applied = {r[0] for r in cur.fetchall()}

    files = sorted([f for f in os.listdir(MIGRATIONS_DIR) if f.endswith('.sql')])
    print(f"Found {len(files)} migration files\n")

    for f in files:
        name = f.replace('.sql', '')
        if name in applied:
            print(f"SKIP (done): {f}")
            continue

        path = os.path.join(MIGRATIONS_DIR, f)
        with open(path, 'r', encoding='utf-8') as fh:
            sql = fh.read()

        # Remove TimescaleDB lines
        lines = sql.split('\n')
        clean = []
        for line in lines:
            if should_skip(line):
                print(f"  Removing TimescaleDB line: {line.strip()[:70]}")
                continue
            clean.append(line)
        sql = '\n'.join(clean)

        # Remove DO blocks that check _migrations (causes issues with autocommit)
        # Replace BEGIN/COMMIT with empty since autocommit is on
        sql = sql.replace('BEGIN;', '').replace('COMMIT;', '')

        try:
            cur.execute(sql)
            print(f"OK: {f}")
        except Exception as e:
            err = str(e).split('\n')[0]
            print(f"ERROR: {f} -> {err}")

    cur.close()
    conn.close()
    print("\nAll done!")

if __name__ == "__main__":
    run()
