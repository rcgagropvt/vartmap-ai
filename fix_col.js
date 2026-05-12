const fs = require('fs');
const path = require('path');

const apiPath = path.join(__dirname, 'services', 'unified', 'src', 'adminAPI.js');
let code = fs.readFileSync(apiPath, 'utf8');

// Fix the set-district endpoint - replace "name" with "district_name"
const setDistEndpoint = code.indexOf('/api/v1/crop-calendar/set-district');
if (setDistEndpoint !== -1) {
  const endpointBlock = code.substring(setDistEndpoint, setDistEndpoint + 600);
  console.log('Current endpoint:\n', endpointBlock.substring(0, 500));
}

// Replace SELECT id, name with SELECT id, district_name
code = code.replace(
  "SELECT id, name FROM districts_master WHERE LOWER(name) ILIKE $1 OR LOWER(district_name) ILIKE $1 LIMIT 1",
  "SELECT id, district_name FROM districts_master WHERE LOWER(district_name) ILIKE $1 LIMIT 1"
);

// Fix the response too
code = code.replace(
  "res.json({ success: true, district: dm[0].name, district_id: distId });",
  "res.json({ success: true, district: dm[0].district_name, district_id: distId });"
);

// Also fix in the onboarding (gateway.js) - same issue
const gwPath = path.join(__dirname, 'services', 'unified', 'src', 'gateway.js');
let gwCode = fs.readFileSync(gwPath, 'utf8');

gwCode = gwCode.replace(
  "SELECT id FROM districts_master WHERE LOWER(name) ILIKE $1 OR LOWER(district_name) ILIKE $1 LIMIT 1",
  "SELECT id FROM districts_master WHERE LOWER(district_name) ILIKE $1 LIMIT 1"
);

// Also fix in the nutrition schedule endpoint
code = code.replace(
  "SELECT name FROM districts_master WHERE id = $1",
  "SELECT district_name as name FROM districts_master WHERE id = $1"
);

fs.writeFileSync(apiPath, code);
fs.writeFileSync(gwPath, gwCode);

console.log('adminAPI.js size:', (Buffer.byteLength(code) / 1024).toFixed(1), 'KB');
console.log('gateway.js size:', (Buffer.byteLength(gwCode) / 1024).toFixed(1), 'KB');

try {
  require('child_process').execSync('node --check "' + apiPath + '"', { encoding: 'utf8' });
  console.log('adminAPI.js SYNTAX: PASSED');
} catch(e) { console.log('adminAPI.js SYNTAX: FAILED\n' + e.stderr.split('\n')[0]); }

try {
  require('child_process').execSync('node --check "' + gwPath + '"', { encoding: 'utf8' });
  console.log('gateway.js SYNTAX: PASSED');
} catch(e) { console.log('gateway.js SYNTAX: FAILED\n' + e.stderr.split('\n')[0]); }
