
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, 'rewards_migration.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('Rewards tables created successfully');
  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    pool.end();
  }
}
run();
