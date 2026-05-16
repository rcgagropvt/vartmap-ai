const fs = require('fs');
const apiPath = 'C:\\Users\\devas\\OneDrive\\Desktop\\vartmap\\services\\unified\\src\\adminAPI.js';
let api = fs.readFileSync(apiPath, 'utf8');

// ===== FIX 1: Update fetch-mandi-prices endpoint response format =====
const oldFetchHandler = `app.get('/api/v1/fetch-mandi-prices', auth, async (req, res) => {
    try {
      const date = req.query.date || new Date().toISOString().split('T')[0];
      const inserted = await syncMandiPrices(date);
      const latest = await pool.query('SELECT COUNT(*) as total, MAX(price_date) as latest FROM mandi_prices');
      res.json({ success: true, inserted, total: latest.rows[0].total, latest_date: latest.rows[0].latest, source: 'agmarknet.gov.in' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });`;

const newFetchHandler = `app.get('/api/v1/fetch-mandi-prices', auth, async (req, res) => {
    try {
      const date = req.query.date || new Date().toISOString().split('T')[0];
      const state = req.query.state || '';
      const commodity = req.query.commodity || '';
      const limit = parseInt(req.query.limit) || 100;

      // First try Agmarknet sync
      let inserted = 0;
      try {
        inserted = await syncMandiPrices(date);
      } catch (syncErr) {
        console.log('[Mandi] Agmarknet sync error:', syncErr.message);
      }

      // If Agmarknet returned nothing, try data.gov.in
      if (inserted === 0) {
        try {
          const axios = require('axios');
          let dgUrl = 'https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=' + (process.env.DATA_GOV_API_KEY || '579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b') + '&format=json&limit=' + limit;
          if (state) dgUrl += '&filters[state]=' + encodeURIComponent(state);
          if (commodity) dgUrl += '&filters[commodity]=' + encodeURIComponent(commodity);
          const dgResp = await axios.get(dgUrl, { timeout: 15000 });
          if (dgResp.data?.records?.length > 0) {
            for (const rec of dgResp.data.records) {
              try {
                await pool.query(
                  \`INSERT INTO mandi_prices (commodity, variety, market_name, district, state, min_price, max_price, modal_price, unit, price_date, source)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                   ON CONFLICT ON CONSTRAINT uq_mandi_price DO UPDATE SET min_price=EXCLUDED.min_price, max_price=EXCLUDED.max_price, modal_price=EXCLUDED.modal_price, source=EXCLUDED.source\`,
                  [rec.commodity, rec.variety || '', rec.market || rec.district || '', rec.district || '', rec.state || '', rec.min_price || 0, rec.max_price || 0, rec.modal_price || 0, 'Quintal', rec.arrival_date || date, 'data.gov.in']
                );
                inserted++;
              } catch (e) { /* skip */ }
            }
          }
        } catch (dgErr) {
          console.log('[Mandi] data.gov.in fallback error:', dgErr.message);
        }
      }

      const latest = await pool.query('SELECT COUNT(*) as total, MAX(price_date) as latest FROM mandi_prices');
      const sample = await pool.query('SELECT commodity, modal_price, market_name as market FROM mandi_prices ORDER BY created_at DESC LIMIT 5');
      
      res.json({
        success: true,
        message: inserted > 0 ? 'Successfully fetched ' + inserted + ' price records' : 'No new records available for today',
        fetched: inserted,
        inserted: inserted,
        total: parseInt(latest.rows[0].total),
        latest_date: latest.rows[0].latest,
        sample: sample.rows,
        source: inserted > 0 ? 'agmarknet.gov.in + data.gov.in' : 'database'
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });`;

const fetchIdx = api.indexOf("app.get('/api/v1/fetch-mandi-prices'");
if (fetchIdx === -1) {
  console.log('ERROR: fetch-mandi-prices not found');
  process.exit(1);
}

// Find end of this handler
const afterFetch = api.indexOf('// Auto-sync', fetchIdx);
if (afterFetch === -1) {
  console.log('ERROR: Could not find end marker for fetch-mandi-prices');
  process.exit(1);
}

const oldBlock = api.substring(fetchIdx, afterFetch).trimEnd();
console.log('Old fetch handler length:', oldBlock.length);

api = api.substring(0, fetchIdx) + newFetchHandler + '\n\n  ' + api.substring(afterFetch);
console.log('Replaced fetch-mandi-prices handler');

// ===== FIX 2: Update admin GET /mandi-prices to return more records =====
const adminGetOld = "q += ' ORDER BY price_date DESC, commodity LIMIT 200';";
const adminGetNew = "q += ' ORDER BY price_date DESC, commodity LIMIT 500';";
if (api.includes(adminGetOld)) {
  api = api.replace(adminGetOld, adminGetNew);
  console.log('Increased admin mandi limit from 200 to 500');
} else {
  // Try the exact pattern from code
  const limitPattern = api.match(/ORDER BY price_date DESC, commodity LIMIT \d+/);
  if (limitPattern) {
    console.log('Found limit pattern:', limitPattern[0]);
    api = api.replace(limitPattern[0], 'ORDER BY price_date DESC, commodity LIMIT 500');
    console.log('Updated limit to 500');
  }
}

// ===== FIX 3: Improve auto-sync to run more frequently and fetch for multiple days =====
const oldAutoSync = `(async () => {
    try {
      const latest = await pool.query('SELECT MAX(price_date) as d FROM mandi_prices');
      const lastDate = latest.rows[0].d;
      const today = new Date().toISOString().split('T')[0];
      if (!lastDate || lastDate.toISOString().split('T')[0] < today) {
        console.log('[Mandi] Auto-syncing prices from Agmarknet...');
        const n = await syncMandiPrices(today);
        console.log(\`[Mandi] Synced \${n} price records for \${today}\`);
      }
    } catch (e) { console.error('[Mandi] Aut`;

// Find the auto-sync block
const autoSyncIdx = api.indexOf("// Auto-sync on server start");
if (autoSyncIdx !== -1) {
  // Find the end of the auto-sync IIFE - look for the setInterval or next section
  let autoEnd = api.indexOf('setInterval', autoSyncIdx);
  if (autoEnd !== -1) {
    // Find the closing of the setInterval block
    autoEnd = api.indexOf('});', autoEnd + 50);
    if (autoEnd !== -1) autoEnd += 3;
  }
  
  // If we can't find a clean end, look for next route definition
  if (autoEnd === -1 || autoEnd - autoSyncIdx > 2000) {
    autoEnd = api.indexOf('\n  app.', autoSyncIdx + 100);
    if (autoEnd === -1) autoEnd = api.indexOf('\n  // ---', autoSyncIdx + 100);
  }
  
  if (autoEnd !== -1 && autoEnd - autoSyncIdx < 2000) {
    const oldAuto = api.substring(autoSyncIdx, autoEnd);
    console.log('Old auto-sync length:', oldAuto.length);
    
    const newAutoSync = `// Auto-sync on server start (runs once, then every 4 hours)
  (async () => {
    try {
      const latest = await pool.query('SELECT MAX(price_date) as d FROM mandi_prices');
      const lastDate = latest.rows[0]?.d;
      const today = new Date().toISOString().split('T')[0];
      if (!lastDate || lastDate.toISOString().split('T')[0] < today) {
        console.log('[Mandi] Auto-syncing prices from Agmarknet...');
        const n = await syncMandiPrices(today);
        console.log('[Mandi] Synced ' + n + ' price records for ' + today);
        // Also try data.gov.in for more coverage
        try {
          const axios = require('axios');
          const dgUrl = 'https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=' + (process.env.DATA_GOV_API_KEY || '579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b') + '&format=json&limit=500';
          const dgResp = await axios.get(dgUrl, { timeout: 15000 });
          let dgInserted = 0;
          if (dgResp.data?.records?.length > 0) {
            for (const rec of dgResp.data.records) {
              try {
                await pool.query(
                  \`INSERT INTO mandi_prices (commodity, variety, market_name, district, state, min_price, max_price, modal_price, unit, price_date, source)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                   ON CONFLICT ON CONSTRAINT uq_mandi_price DO UPDATE SET min_price=EXCLUDED.min_price, max_price=EXCLUDED.max_price, modal_price=EXCLUDED.modal_price, source=EXCLUDED.source\`,
                  [rec.commodity, rec.variety || '', rec.market || rec.district || '', rec.district || '', rec.state || '', rec.min_price || 0, rec.max_price || 0, rec.modal_price || 0, 'Quintal', rec.arrival_date || today, 'data.gov.in']
                );
                dgInserted++;
              } catch (e) { /* skip duplicates */ }
            }
            console.log('[Mandi] data.gov.in added ' + dgInserted + ' records');
          }
        } catch (dgErr) { console.log('[Mandi] data.gov.in sync error:', dgErr.message); }
      } else {
        console.log('[Mandi] Already have data for ' + today + ', skipping sync');
      }
    } catch (e) { console.error('[Mandi] Auto-sync error:', e.message); }
  })();

  // Re-sync every 4 hours
  setInterval(async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      console.log('[Mandi] Scheduled sync for ' + today);
      const n = await syncMandiPrices(today);
      console.log('[Mandi] Scheduled sync: ' + n + ' records');
    } catch (e) { console.error('[Mandi] Scheduled sync error:', e.message); }
  }, 4 * 60 * 60 * 1000);`;

    api = api.substring(0, autoSyncIdx) + newAutoSync + api.substring(autoEnd);
    console.log('Replaced auto-sync block');
  } else {
    console.log('Could not find clean auto-sync boundaries, autoEnd:', autoEnd, 'distance:', autoEnd - autoSyncIdx);
  }
}

// Write and check
fs.writeFileSync(apiPath, api, 'utf8');
console.log('\nFile size:', (api.length / 1024).toFixed(1), 'KB');

const { execSync } = require('child_process');
try {
  execSync('node --check "' + apiPath + '"', { encoding: 'utf8' });
  console.log('Syntax check: PASSED');
} catch (e) {
  console.log('Syntax check: FAILED');
  console.log(e.message.substring(0, 500));
}

// Cleanup
fs.unlinkSync('C:\\Users\\devas\\OneDrive\\Desktop\\vartmap\\check_db.js');
console.log('\nDone! Deploy to see changes.');
