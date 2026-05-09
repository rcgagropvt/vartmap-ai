const fs = require('fs');
const file = 'services/unified/src/adminAPI.js';
let code = fs.readFileSync(file, 'utf8');
const lines = code.split('\n');

// Find the "END YOUTUBE SHORTS SYNC" marker and the code block
const endMarkerIdx = lines.findIndex(l => l.includes('END YOUTUBE SHORTS SYNC'));
const startMarkerIdx = lines.findIndex(l => l.includes('YOUTUBE SHORTS AUTO-SYNC'));

if (startMarkerIdx === -1) {
  console.log('No YouTube sync code found to fix');
  process.exit(1);
}

// Extract the sync code block
const syncBlock = lines.slice(startMarkerIdx, endMarkerIdx + 1).join('\n');

// Remove it from current position
lines.splice(startMarkerIdx, endMarkerIdx - startMarkerIdx + 1);

// Now find the closing of module.exports function - it should be the last '};' or '}'
// Actually we need to insert BEFORE the last closing bracket of the setupAdminAPI function
// Find the line just before where the sync code was (which is now the end of the function)
// Let's find the last route endpoint before the end and insert after it

// Look for the last app.get or app.post line before the removed block
let insertAt = startMarkerIdx - 1;
// Skip blank lines
while (insertAt > 0 && lines[insertAt].trim() === '') insertAt--;
// Insert after this line (which should be a closing });)
insertAt++;

lines.splice(insertAt, 0, syncBlock);

code = lines.join('\n');
fs.writeFileSync(file, code, 'utf8');
console.log('Sync code repositioned to line ' + (insertAt + 1));
