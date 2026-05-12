const fs = require('fs');
const path = require('path');

const apiPath = path.join(__dirname, 'services', 'unified', 'src', 'adminAPI.js');
let code = fs.readFileSync(apiPath, 'utf8');

// Find the nutrition schedule endpoint's soil fallback section
const nutritionStart = code.indexOf('// ====== NUTRITION SCHEDULE GENERATOR ======');
const initTables = code.indexOf('app.get("/api/v1/crop-calendar/list-districts"');
console.log('Nutrition section:', nutritionStart, 'to', initTables);

const nutritionCode = code.substring(nutritionStart, initTables);

// Find the district resolution - currently looks up districts_master which is empty
// Replace with direct lookup from farmer's village field (which stores "basti")
const districtResolve = nutritionCode.indexOf('districts_master WHERE id =');
console.log('District resolve in nutrition at:', districtResolve);

// Find the soil data parsing section
const soilParse = nutritionCode.indexOf('nLow');
console.log('Soil parsing at offset:', soilParse);
if (soilParse !== -1) {
  console.log('Current parsing:', nutritionCode.substring(soilParse, soilParse + 300));
}

// Now let's replace the entire district + soil resolution block
// Find from "let districtName" to the soilData construction end
const distNameStart = nutritionCode.indexOf('let districtName');
const soilDataEnd = nutritionCode.indexOf('// Generate schedule');
console.log('District block:', distNameStart, 'to', soilDataEnd);

if (distNameStart !== -1 && soilDataEnd !== -1) {
  const beforeBlock = nutritionCode.substring(0, distNameStart);
  const afterBlock = nutritionCode.substring(soilDataEnd);
  
  const newBlock = `let districtName = '';
      let soilData = null;
      
      // Get district name - try districts_master first, then farmer.village
      if (reg.district_id) {
        const { rows: distRows } = await pool.query("SELECT district_name FROM districts_master WHERE id = $1", [reg.district_id]);
        if (distRows.length) districtName = distRows[0].district_name.toLowerCase();
      }
      if (!districtName && farmer.village) {
        districtName = farmer.village.toLowerCase();
      }
      
      // Get soil data from soil_nutrient_data using district name
      if (districtName) {
        const { rows: distSoil } = await pool.query(
          "SELECT nitrogen_low_pct, nitrogen_medium_pct, nitrogen_high_pct, phosphorus_low_pct, phosphorus_medium_pct, phosphorus_high_pct, potassium_low_pct, potassium_medium_pct, potassium_high_pct, organic_carbon_low_pct, avg_ph, avg_zinc, avg_boron, avg_sulphur, soil_type, block_name, recommendations FROM soil_nutrient_data WHERE LOWER(district_name) ILIKE $1 LIMIT 10",
          ['%' + districtName + '%']
        );
        if (distSoil.length) {
          // Average the percentages across blocks
          const avg = (arr, key) => arr.reduce((s, r) => s + parseFloat(r[key] || 0), 0) / arr.length;
          const nLowPct = avg(distSoil, 'nitrogen_low_pct');
          const pLowPct = avg(distSoil, 'phosphorus_low_pct');
          const kLowPct = avg(distSoil, 'potassium_low_pct');
          const ocLowPct = avg(distSoil, 'organic_carbon_low_pct');
          
          soilData = {
            n_status: nLowPct > 50 ? 'low' : nLowPct > 20 ? 'medium' : 'high',
            p_status: pLowPct > 50 ? 'low' : pLowPct > 20 ? 'medium' : 'high',
            k_status: kLowPct > 50 ? 'low' : kLowPct > 20 ? 'medium' : 'high',
            oc_status: ocLowPct > 50 ? 'low' : 'medium',
            ph: avg(distSoil, 'avg_ph'),
            zinc_deficient: avg(distSoil, 'avg_zinc') < 50,
            boron_deficient: avg(distSoil, 'avg_boron') < 50,
            sulphur_deficient: avg(distSoil, 'avg_sulphur') < 50,
            soil_type: distSoil[0].soil_type || 'unknown',
            blocks_sampled: distSoil.map(r => r.block_name).filter(Boolean),
            recommendations: distSoil[0].recommendations || {},
            source: 'soil_nutrient_data (district avg of ' + distSoil.length + ' blocks)',
            n_low_pct: nLowPct.toFixed(1),
            p_low_pct: pLowPct.toFixed(1),
            k_low_pct: kLowPct.toFixed(1)
          };
        }
      }

      `;
  
  const newNutrition = beforeBlock + newBlock + afterBlock;
  code = code.substring(0, nutritionStart) + newNutrition + code.substring(initTables);
  console.log('Replaced district + soil resolution block');
}

// Also fix the set-district endpoint to store in farmer.village when districts_master is empty
// This is already done - it stores as village. Good.

// Fix the next-action endpoint similarly
const nextAction = code.indexOf('/api/v1/crop-calendar/next-action');
const nextActionEnd = code.indexOf('app.get("/api/v1/crop-calendar/set-district"');
if (nextAction !== -1 && nextActionEnd !== -1) {
  const naCode = code.substring(nextAction, nextActionEnd);
  // Fix district lookup here too
  if (naCode.includes("SELECT district_name FROM districts_master")) {
    const fixed = naCode.replace(
      /if \(farmer\.district_id\) \{ const \{ rows: d \} = await pool\.query\("SELECT district_name FROM districts_master WHERE id = \$1", \[farmer\.district_id\]\); if \(d\.length\) districtName = d\[0\]\.district_name\.toLowerCase\(\); \}/,
      "if (farmer.district_id) { const { rows: d } = await pool.query(\"SELECT district_name FROM districts_master WHERE id = $1\", [farmer.district_id]); if (d.length) districtName = d[0].district_name.toLowerCase(); }\n      if (!districtName && farmer.village) { districtName = farmer.village.toLowerCase(); }"
    );
    code = code.substring(0, nextAction) + fixed + code.substring(nextActionEnd);
    console.log('Fixed next-action district lookup with village fallback');
  }
}

fs.writeFileSync(apiPath, code);
console.log('\nFile size:', (Buffer.byteLength(code) / 1024).toFixed(1), 'KB');

const { execSync } = require('child_process');
try {
  execSync('node --check "' + apiPath + '"', { encoding: 'utf8' });
  console.log('SYNTAX CHECK: PASSED');
} catch(e) {
  console.log('SYNTAX CHECK: FAILED');
  console.log(e.stderr.split('\n').slice(0, 5).join('\n'));
}
