const fs = require('fs');
const path = require('path');

const gwPath = path.join(__dirname, 'services', 'unified', 'src', 'gateway.js');
const gwCode = fs.readFileSync(gwPath, 'utf8');

// Find where interactive list_reply messages are processed
const listReplyIdx = gwCode.indexOf('list_reply');
console.log('list_reply occurrences:');
let idx = 0;
let count = 0;
while ((idx = gwCode.indexOf('list_reply', idx)) !== -1 && count < 10) {
  const lineStart = gwCode.lastIndexOf('\n', idx) + 1;
  const lineEnd = gwCode.indexOf('\n', idx);
  console.log(`  ${count} (pos ${idx}): ${gwCode.substring(lineStart, lineEnd).trim()}`);
  idx++;
  count++;
}

// Find where interactive messages set msgBody or lowerMsg
const interactiveIdx = gwCode.indexOf("messageType === 'interactive'");
if (interactiveIdx !== -1) {
  console.log('\n\nInteractive handling:');
  console.log(gwCode.substring(interactiveIdx - 50, interactiveIdx + 600));
}

// Also check what happens when "Hi" is sent - find the menu trigger
const hiIdx = gwCode.indexOf("'hi'");
if (hiIdx !== -1) {
  // Find the menu trigger context
  const menuTriggers = gwCode.indexOf('sendMenuMessage');
  if (menuTriggers !== -1) {
    // Find the first call to sendMenuMessage in the main handler (after line 1700)
    const lines = gwCode.split('\n');
    for (let i = 1700; i < Math.min(1950, lines.length); i++) {
      if (lines[i].includes('sendMenuMessage') || lines[i].includes('menu') || lines[i].includes("'hi'")) {
        console.log(`  ${i+1}: ${lines[i]}`);
      }
    }
  }
}

// Check if there's an error happening before menu - show lines 1730-1755
const lines = gwCode.split('\n');
console.log('\n\nLines 1730-1760:');
for (let i = 1729; i < Math.min(1760, lines.length); i++) {
  console.log(`  ${i+1}: ${lines[i]}`);
}
