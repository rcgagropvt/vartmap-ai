const fs = require('fs');
const path = require('path');

const apiPath = path.join(__dirname, 'services', 'unified', 'src', 'adminAPI.js');
let code = fs.readFileSync(apiPath, 'utf8');

// Find the nutrition schedule endpoint
const endpointStart = code.indexOf('app.get("/api/v1/crop-calendar/nutrition-schedule/:registrationId"');
const endpointEnd = code.indexOf('app.get("/api/v1/crop-calendar/next-action', endpointStart);

let endpoint = code.substring(endpointStart, endpointEnd);
console.log('Endpoint length:', endpoint.length);

// Check the order of operations
const distNameDecl = endpoint.indexOf("let districtName = ''");
const soilFallback = endpoint.indexOf('// Fallback: get district-level soil data');
const soilHealthCheck = endpoint.indexOf('soil_health_cards WHERE farmer_id');

console.log('districtName declared at offset:', distNameDecl);
console.log('soil_health_cards check at offset:', soilHealthCheck);
console.log('soil fallback at offset:', soilFallback);

// The problem: soil fallback uses districtName but it's declared AFTER the soil block
// Solution: move the soil fallback to AFTER districtName is resolved

// Remove the soil fallback from its current position
const fallbackStart = endpoint.indexOf('        // Fallback: get district-level soil data');
const fallbackEnd = endpoint.indexOf('\n        }\n', fallbackStart + 100);
const fullFallbackEnd = endpoint.indexOf('\n', fallbackEnd + 10) + 1;

if (fallbackStart !== -1 && fullFallbackEnd !== -1) {
  const fallbackCode = endpoint.substring(fallbackStart, fullFallbackEnd);
  console.log('\nFallback block length:', fallbackCode.length);
  console.log('First 100:', fallbackCode.substring(0, 100));
  
  // Remove from current position
  endpoint = endpoint.substring(0, fallbackStart) + endpoint.substring(fullFallbackEnd);
  
  // Insert AFTER districtName is resolved (after the districts_master query)
  const afterDistrictQuery = endpoint.indexOf("if (distRows.length) districtName = distRows[0].name.toLowerCase()");
  const afterDistrictLine = endpoint.indexOf('\n', afterDistrictQuery + 50) + 1;
  const afterDistrictBlock = endpoint.indexOf('\n', afterDistrictLine) + 1;
  
  // Also need to use pin_code/district from farmer profile for soil lookup
  const enhancedFallback = `        // Fallback: get district-level soil data from soil_nutrient_data
        if (!soilData) {
          let soilDistrict = districtName;
          if (!soilDistrict && reg.village) soilDistrict = reg.village;
          if (soilDistrict) {
            const { rows: distSoil } = await pool.query("SELECT nitrogen_status, phosphorus_status, potassium_status, ph, organic_carbon, micronutrients FROM soil_nutrient_data WHERE LOWER(district_name) ILIKE $1 LIMIT 5", ['%' + soilDistrict + '%']);
            if (distSoil.length) {
              const nLow = distSoil.filter(r => r.nitrogen_status === 'low' || r.nitrogen_status === 'Low').length;
              const pLow = distSoil.filter(r => r.phosphorus_status === 'low' || r.phosphorus_status === 'Low').length;
              const kLow = distSoil.filter(r => r.potassium_status === 'low' || r.potassium_status === 'Low').length;
              const total = distSoil.length;
              soilData = { n_status: nLow > total/2 ? 'low' : 'medium', p_status: pLow > total/2 ? 'low' : 'medium', k_status: kLow > total/2 ? 'low' : 'medium', ph: distSoil[0].ph, organic_carbon: distSoil[0].organic_carbon, micronutrients: distSoil[0].micronutrients, source: 'district_average', samples: total };
            }
          }
        }
`;
  endpoint = endpoint.substring(0, afterDistrictBlock) + enhancedFallback + endpoint.substring(afterDistrictBlock);
  console.log('Moved and enhanced soil fallback to after district resolution');
}

// Replace the endpoint in full code
code = code.substring(0, endpointStart) + endpoint + code.substring(endpointEnd);

// Also set district from pin_code if district_id is null
// Find where it queries districts_master
const distQuery = code.indexOf("SELECT name FROM districts_master WHERE id = $1", endpointStart);
if (distQuery !== -1) {
  const afterDistQ = code.indexOf('\n', code.indexOf('\n', distQuery) + 1) + 1;
  // Add pin_code based district lookup
  const pinFallback = `      // Fallback: try to get district from pin_code
      if (!districtName && reg.village) {
        const { rows: pinDist } = await pool.query("SELECT DISTINCT district_name FROM soil_nutrient_data WHERE LOWER(village_name) ILIKE $1 LIMIT 1", ['%' + reg.village.toLowerCase() + '%']);
        if (pinDist.length) districtName = pinDist[0].district_name.toLowerCase();
      }
`;
  // Don't add this if it'll break ordering - skip for now
}

fs.writeFileSync(apiPath, code);
console.log('\nFile size:', (Buffer.byteLength(code) / 1024).toFixed(1), 'KB');

try {
  require('child_process').execSync('node --check "' + apiPath + '"', { encoding: 'utf8' });
  console.log('SYNTAX CHECK: PASSED');
} catch(e) {
  console.log('SYNTAX CHECK: FAILED');
  console.log(e.stderr.split('\n').slice(0,3).join('\n'));
}
