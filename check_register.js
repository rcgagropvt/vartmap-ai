const fs = require('fs');
const path = require('path');

// ===== PART 1: Check adminAPI.js for the register endpoint =====
const apiPath = path.join(__dirname, 'services', 'unified', 'src', 'adminAPI.js');
let apiCode = fs.readFileSync(apiPath, 'utf8');

// Find the register endpoint
const regIdx = apiCode.indexOf('/crop-calendar/register');
if (regIdx === -1) {
  console.log('ERROR: /crop-calendar/register endpoint not found in adminAPI.js');
  process.exit(1);
}
console.log('Found /crop-calendar/register at char:', regIdx);

// Show 80 lines around it
const before = apiCode.substring(regIdx - 200, regIdx + 2000);
const lines = before.split('\n').slice(0, 60);
lines.forEach((l, i) => console.log(`  ${i}: ${l}`));

// ===== PART 2: Check gateway.js for sendMenuMessage =====
console.log('\n\n--- MENU CHECK ---');
const gwPath = path.join(__dirname, 'services', 'unified', 'src', 'gateway.js');
let gwCode = fs.readFileSync(gwPath, 'utf8');

// Find sendMenuMessage function or the menu rows
const menuIdx = gwCode.indexOf('sendMenuMessage');
if (menuIdx === -1) {
  console.log('sendMenuMessage not found');
} else {
  // find the actual function definition
  const funcIdx = gwCode.indexOf('function sendMenuMessage', menuIdx > 500 ? menuIdx - 500 : 0);
  const altIdx = gwCode.indexOf('async function sendMenuMessage');
  const startIdx = funcIdx !== -1 ? funcIdx : (altIdx !== -1 ? altIdx : menuIdx);
  const menuSnippet = gwCode.substring(startIdx, startIdx + 2500);
  const menuLines = menuSnippet.split('\n').slice(0, 70);
  menuLines.forEach((l, i) => console.log(`  ${i}: ${l}`));
}
