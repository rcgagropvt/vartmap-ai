const fs = require('fs');
const path = require('path');

const apiPath = path.join(__dirname, 'services', 'unified', 'src', 'adminAPI.js');
let apiCode = fs.readFileSync(apiPath, 'utf8');

// ===== PART 1: Ensure menu item is added =====
// Find the crop calendar table init IIFE and add menu seeding
if (apiCode.includes('fasal_calendar')) {
  console.log('fasal_calendar already in adminAPI.js');
} else {
  // Find where the crop calendar templates are seeded
  const seedEnd = apiCode.indexOf('crop calendar templates"');
  if (seedEnd === -1) {
    // Try different search
    const altSeed = apiCode.indexOf('crop_calendar_templates');
    if (altSeed !== -1) {
      console.log('Found crop_calendar_templates at:', altSeed);
      // Find the end of the IIFE block - look for the closing })(); 
      const iifeEnd = apiCode.indexOf('})();', altSeed);
      if (iifeEnd !== -1) {
        // Insert menu item code just before })();
        const menuCode = `
    // Add Fasal Calendar to menu if not exists
    try {
      const { rows: bcRows } = await pool.query("SELECT id, menu_items FROM bot_configs LIMIT 1");
      if (bcRows.length > 0) {
        let mitems = bcRows[0].menu_items || [];
        if (typeof mitems === 'string') mitems = JSON.parse(mitems);
        const hasFasal = mitems.some(m => m.menu_key === 'fasal_calendar');
        if (!hasFasal) {
          mitems.push({
            menu_key: 'fasal_calendar',
            title_hi: 'Fasal Calendar',
            title_en: 'Crop Calendar',
            description_hi: 'Fasal register karein, growth reminders paayein',
            description_en: 'Register crop, get growth stage reminders',
            is_active: true,
            sort_order: mitems.length + 1
          });
          await pool.query("UPDATE bot_configs SET menu_items=$1 WHERE id=$2", [JSON.stringify(mitems), bcRows[0].id]);
          console.log("Added Fasal Calendar to bot menu");
        }
      }
    } catch(menuErr) { console.error("Menu seed error:", menuErr.message); }

`;
        apiCode = apiCode.substring(0, iifeEnd) + menuCode + apiCode.substring(iifeEnd);
        fs.writeFileSync(apiPath, apiCode);
        console.log('Inserted menu item seeding before IIFE close');
      } else {
        console.log('Could not find IIFE end');
      }
    } else {
      console.log('crop_calendar_templates not found at all - need full insert');
    }
  } else {
    console.log('Found seed end marker at:', seedEnd);
  }
}

// ===== PART 2: Verify gateway.js has fasal_calendar handling =====
const gwPath = path.join(__dirname, 'services', 'unified', 'src', 'gateway.js');
let gwCode = fs.readFileSync(gwPath, 'utf8');

if (gwCode.includes('fasal_calendar')) {
  console.log('gateway.js already handles fasal_calendar');
  // Show context
  const idx = gwCode.indexOf('fasal_calendar');
  const ctx = gwCode.substring(idx - 100, idx + 150);
  console.log('Context:', ctx.replace(/\n/g, ' | '));
} else {
  console.log('WARNING: fasal_calendar NOT in gateway.js - adding...');
  // Find the crop calendar trigger
  const triggers = ['fasal register', 'meri fasal', 'crop calendar', 'crop register'];
  for (const t of triggers) {
    const tIdx = gwCode.indexOf(`'${t}'`);
    if (tIdx !== -1) {
      console.log(`Found trigger '${t}' at char ${tIdx}`);
      // Find the if condition containing it
      const condStart = gwCode.lastIndexOf('if (', tIdx);
      const condEnd = gwCode.indexOf(') {', tIdx);
      if (condEnd !== -1 && condEnd - tIdx < 300) {
        const oldCond = gwCode.substring(condStart, condEnd + 3);
        const newCond = oldCond.replace(') {', " || cropMsg === 'fasal_calendar') {");
        gwCode = gwCode.replace(oldCond, newCond);
        fs.writeFileSync(gwPath, gwCode);
        console.log('Added fasal_calendar to condition');
        break;
      }
    }
  }
}

// ===== PART 3: Add direct DB table creation endpoint (backup) =====
// Add a GET endpoint that creates tables - useful for first deploy
if (!apiCode.includes('/api/v1/crop-calendar/init-tables')) {
  apiCode = fs.readFileSync(apiPath, 'utf8');
  const insertBefore = apiCode.indexOf('// Register farmer crop (from app or bot)');
  if (insertBefore !== -1) {
    const initEndpoint = `
  // Manual table init endpoint (call once)
  app.get("/api/v1/crop-calendar/init-tables", async (req, res) => {
    try {
      await pool.query(\`
        CREATE TABLE IF NOT EXISTS crop_calendar_templates (
          id SERIAL PRIMARY KEY,
          crop VARCHAR(100) NOT NULL,
          stage_name VARCHAR(200) NOT NULL,
          day_offset INTEGER NOT NULL,
          message_hi TEXT,
          message_en TEXT,
          activity TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS farmer_crop_registrations (
          id SERIAL PRIMARY KEY,
          farmer_id UUID REFERENCES farmers(id),
          crop VARCHAR(100) NOT NULL,
          sow_date DATE NOT NULL,
          land_area DECIMAL,
          next_reminder_date DATE,
          status VARCHAR(20) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS crop_reminders_log (
          id SERIAL PRIMARY KEY,
          registration_id INTEGER REFERENCES farmer_crop_registrations(id),
          farmer_id UUID REFERENCES farmers(id),
          stage_name VARCHAR(200),
          message_sent TEXT,
          sent_at TIMESTAMP DEFAULT NOW()
        );
      \`);
      res.json({ success: true, message: "Tables created" });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

`;
    apiCode = apiCode.substring(0, insertBefore) + initEndpoint + apiCode.substring(insertBefore);
    fs.writeFileSync(apiPath, apiCode);
    console.log('Added /api/v1/crop-calendar/init-tables endpoint');
  }
}

console.log('\nAPI file size:', (Buffer.byteLength(fs.readFileSync(apiPath)) / 1024).toFixed(1), 'KB');
console.log('Gateway file size:', (Buffer.byteLength(fs.readFileSync(gwPath)) / 1024).toFixed(1), 'KB');
console.log('\nDONE! After deploy, hit: https://vartmap.onrender.com/api/v1/crop-calendar/init-tables');
