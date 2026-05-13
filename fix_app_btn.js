const fs = require('fs');
const appDir = 'C:\\Users\\devas\\OneDrive\\Desktop\\vartmap-farmer-app';

// Fix 1: nutrition-schedule.tsx - fix the Smart Khaad button
const nsPath = appDir + '\\app\\nutrition-schedule.tsx';
let ns = fs.readFileSync(nsPath, 'utf8');

// Find the broken button and replace it
const oldBtn = ns.match(/<TouchableOpacity style=\{[^}]+backgroundColor:'#e8f5e9'[^]*?<\/TouchableOpacity>/);
if (oldBtn) {
  // Remove the broken button
  ns = ns.replace(oldBtn[0], '');
  console.log('Removed broken Smart Settings button');
}

// Now find how the component gets its data - look for registrationId or params
const paramUsage = ns.match(/useLocalSearchParams|route\.params|registrationId/g);
console.log('Param refs in nutrition-schedule: ' + JSON.stringify(paramUsage));

// Find the variable name used for registration ID
const regIdVar = ns.match(/const\s*\{([^}]*registrationId[^}]*)\}/);
const regIdAlt = ns.match(/const\s*\{([^}]*regId[^}]*)\}/);
const paramLine = ns.match(/useLocalSearchParams[^;]*/);
console.log('Params line: ' + (paramLine ? paramLine[0] : 'NOT FOUND'));

// Find where data is loaded - the fetch call
const fetchLine = ns.match(/nutrition[^)]*registrationId|nutrition[^)]*regId|nutrition[^)]*id/i);
console.log('Fetch pattern: ' + (fetchLine ? fetchLine[0] : 'NOT FOUND'));

// Show first 1500 chars to understand structure
console.log('\n=== nutrition-schedule.tsx first 1500 chars ===');
console.log(ns.substring(0, 1500));
