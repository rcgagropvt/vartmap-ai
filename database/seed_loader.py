#!/usr/bin/env python3
"""
database/seed_loader.py
Loads all seed data into PostgreSQL after migrations are applied.
Run: python seed_loader.py  (reads DATABASE_URL from env)
"""

import os
import sys
import json
import csv
import hashlib
import logging
from pathlib import Path
from datetime import datetime

import bcrypt
import psycopg2
from psycopg2.extras import execute_values, Json

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("seed_loader")

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://vartmap:vartmap@localhost:5432/vartmap")
SEEDS_DIR = Path(__file__).parent / "seeds"


def get_conn():
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    return conn


# ── 1. Districts ─────────────────────────────────────────────
def seed_districts(cur):
    csv_path = SEEDS_DIR / "districts.csv"
    if not csv_path.exists():
        log.warning("districts.csv not found, skipping")
        return 0

    cur.execute("SELECT COUNT(*) FROM districts")
    existing = cur.fetchone()[0]
    if existing > 100:
        log.info(f"Districts table already has {existing} rows, skipping")
        return 0

    count = 0
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cur.execute("""
                INSERT INTO districts (state_code, state_name, district_name, district_name_hi, latitude, longitude)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (state_code, district_name) DO NOTHING
            """, (
                row["state_code"], row["state_name"], row["district_name"],
                row.get("district_name_hi"), float(row["latitude"]), float(row["longitude"])
            ))
            count += 1
    log.info(f"Seeded {count} districts")
    return count


# ── 2. District Aliases ─────────────────────────────────────
def seed_district_aliases(cur):
    csv_path = SEEDS_DIR / "district_aliases.csv"
    if not csv_path.exists():
        log.warning("district_aliases.csv not found, skipping")
        return 0

    count = 0
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cur.execute("""
                INSERT INTO district_aliases (district_id, alias, alias_type)
                SELECT d.id, %s, %s
                  FROM districts d
                 WHERE LOWER(d.district_name) = LOWER(%s)
                 LIMIT 1
                ON CONFLICT DO NOTHING
            """, (row["alias"], row.get("alias_type", "historical"), row["district_name"]))
            count += 1
    log.info(f"Seeded {count} district aliases")
    return count


# ── 3. Crops ────────────────────────────────────────────────
def seed_crops(cur):
    json_path = SEEDS_DIR / "crops.json"
    if not json_path.exists():
        log.warning("crops.json not found, skipping")
        return 0

    cur.execute("SELECT COUNT(*) FROM crops")
    if cur.fetchone()[0] > 0:
        log.info("Crops already seeded, skipping")
        return 0

    crops = json.loads(json_path.read_text(encoding="utf-8"))
    for c in crops:
        cur.execute("""
            INSERT INTO crops (name, name_hi, category, seasons, major_states,
                               typical_duration_days, msp_per_quintal)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (name) DO NOTHING
        """, (
            c["name"], c.get("name_hi"), c["category"],
            c["seasons"], c.get("major_states", []),
            c.get("typical_duration_days"), c.get("msp_2025_per_quintal")
        ))
    log.info(f"Seeded {len(crops)} crops")
    return len(crops)


# ── 4. Soil Labs ────────────────────────────────────────────
def seed_soil_labs(cur):
    json_path = SEEDS_DIR / "soil_labs.json"
    if not json_path.exists():
        log.warning("soil_labs.json not found, skipping")
        return 0

    cur.execute("SELECT COUNT(*) FROM soil_labs")
    if cur.fetchone()[0] > 0:
        log.info("Soil labs already seeded, skipping")
        return 0

    labs = json.loads(json_path.read_text(encoding="utf-8"))
    for lab in labs:
        cur.execute("""
            INSERT INTO soil_labs (name, state_code, district, address, phone, lab_type, services)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
        """, (
            lab["name"], lab["state_code"], lab["district"],
            lab["address"], lab.get("phone"), lab["type"], lab.get("services", [])
        ))
    log.info(f"Seeded {len(labs)} soil labs")
    return len(labs)


# ── 5. Schemes ──────────────────────────────────────────────
def seed_schemes(cur):
    json_path = SEEDS_DIR / "schemes.json"
    if not json_path.exists():
        log.warning("schemes.json not found, skipping")
        return 0

    cur.execute("SELECT COUNT(*) FROM government_schemes")
    if cur.fetchone()[0] > 0:
        log.info("Schemes already seeded, skipping")
        return 0

    schemes = json.loads(json_path.read_text(encoding="utf-8"))
    for s in schemes:
        cur.execute("""
            INSERT INTO government_schemes
                (name, name_hi, scheme_type, ministry, benefit_summary,
                 eligibility, url, helpline, is_active)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
        """, (
            s["name"], s.get("name_hi"), s["type"], s.get("ministry"),
            s["benefit"], s.get("eligibility"), s.get("url"),
            s.get("helpline"), s.get("is_active", True)
        ))
    log.info(f"Seeded {len(schemes)} schemes")
    return len(schemes)


# ── 6. Calendar Templates ──────────────────────────────────
def seed_calendar_templates(cur):
    json_path = SEEDS_DIR / "calendar_templates.json"
    if not json_path.exists():
        log.warning("calendar_templates.json not found, skipping")
        return 0

    cur.execute("SELECT COUNT(*) FROM crop_calendar_templates")
    if cur.fetchone()[0] > 0:
        log.info("Calendar templates already seeded, skipping")
        return 0

    templates = json.loads(json_path.read_text(encoding="utf-8"))
    for t in templates:
        cur.execute("""
            INSERT INTO crop_calendar_templates
                (crop_name, variety, season, state_code, agro_zone,
                 soil_types, stages, total_duration_days, source)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
        """, (
            t["crop_name"], t.get("variety"), t["season"],
            t.get("state_code"), t.get("agro_zone"),
            t.get("soil_types", []), Json(t["stages"]),
            t.get("total_duration_days"), t.get("source")
        ))
    log.info(f"Seeded {len(templates)} calendar templates")
    return len(templates)


# ── 7. Sample Products ─────────────────────────────────────
def seed_products(cur):
    json_path = SEEDS_DIR / "sample_products.json"
    if not json_path.exists():
        log.warning("sample_products.json not found, skipping")
        return 0

    cur.execute("SELECT COUNT(*) FROM products")
    if cur.fetchone()[0] > 0:
        log.info("Products already seeded, skipping")
        return 0

    products = json.loads(json_path.read_text(encoding="utf-8"))
    for p in products:
        cur.execute("""
            INSERT INTO products
                (brand_name, product_name, category, cibrc_number,
                 manufacturer, is_genuine)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
        """, (
            p["brand_name"], p["product_name"], p["category"],
            p.get("cibrc_number"), p.get("manufacturer"),
            p.get("is_genuine", True)
        ))
    log.info(f"Seeded {len(products)} products")
    return len(products)


# ── 8. Admin Superuser ──────────────────────────────────────
def seed_admin(cur):
    json_path = SEEDS_DIR / "admin_superuser.json"
    if not json_path.exists():
        log.warning("admin_superuser.json not found, skipping")
        return 0

    cur.execute("SELECT COUNT(*) FROM admin_users WHERE role = 'super_admin'")
    if cur.fetchone()[0] > 0:
        log.info("Superadmin already exists, skipping")
        return 0

    admin = json.loads(json_path.read_text(encoding="utf-8"))
    raw_password = os.environ.get("ADMIN_INITIAL_PASSWORD", "ChangeMeImmediately!2026")
    hashed = bcrypt.hashpw(raw_password.encode(), bcrypt.gensalt()).decode()

    cur.execute("""
        INSERT INTO admin_users (email, name, role, password_hash, permissions, is_active)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (email) DO NOTHING
    """, (
        admin["email"], admin["name"], admin["role"],
        hashed, admin.get("permissions", ["*"]), True
    ))
    log.info("Seeded superadmin user")
    return 1


# ── Main ────────────────────────────────────────────────────
def main():
    conn = get_conn()
    try:
        cur = conn.cursor()
        total = 0
        total += seed_districts(cur)
        total += seed_district_aliases(cur)
        total += seed_crops(cur)
        total += seed_soil_labs(cur)
        total += seed_schemes(cur)
        total += seed_calendar_templates(cur)
        total += seed_products(cur)
        total += seed_admin(cur)
        conn.commit()
        log.info(f"Seeding complete. Total records inserted: {total}")
    except Exception as e:
        conn.rollback()
        log.error(f"Seeding failed: {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
