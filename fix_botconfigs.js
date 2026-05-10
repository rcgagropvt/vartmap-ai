const fs = require('fs');
const path = require('path');

const apiPath = path.join(__dirname, 'services', 'unified', 'src', 'adminAPI.js');
let apiCode = fs.readFileSync(apiPath, 'utf8');

// Find all occurrences of bot_configs
let idx = 0;
const occurrences = [];
while ((idx = apiCode.indexOf('bot_configs', idx)) !== -1) {
  const lineStart = apiCode.lastIndexOf('\n', idx) + 1;
  const lineEnd = apiCode.indexOf('\n', idx);
  const line = apiCode.substring(lineStart, lineEnd).trim();
  occurrences.push({ pos: idx, line: line.substring(0, 120) });
  idx++;
}

console.log('Found', occurrences.length, 'occurrences of "bot_configs":');
occurrences.forEach((o, i) => console.log(`  ${i}: pos ${o.pos} => ${o.line}`));

// Find the IIFE that references bot_configs
const iifeStart = apiCode.indexOf('(async () => {');
if (iifeStart !== -1) {
  console.log('\nFound IIFE at char:', iifeStart);
  // Show first 200 chars
  console.log(apiCode.substring(iifeStart, iifeStart + 300));
  
  // Find its end })();
  let braces = 0;
  let iifeEnd = -1;
  for (let i = iifeStart; i < apiCode.length; i++) {
    if (apiCode[i] === '{') braces++;
    if (apiCode[i] === '}') braces--;
    if (braces === 0 && i > iifeStart + 10) {
      // find the ();\n after
      iifeEnd = apiCode.indexOf(';', i) + 1;
      break;
    }
  }
  if (iifeEnd !== -1) {
    console.log('\nIIFE ends at char:', iifeEnd);
    console.log('IIFE length:', iifeEnd - iifeStart, 'chars');
    const iifeContent = apiCode.substring(iifeStart, iifeEnd);
    if (iifeContent.includes('bot_configs')) {
      console.log('\nIIFE contains bot_configs reference - REMOVING IT');
      // Remove the IIFE and any comment before it
      const commentStart = apiCode.lastIndexOf('// =====', iifeStart);
      const removeFrom = (commentStart !== -1 && iifeStart - commentStart < 100) ? commentStart : iifeStart;
      apiCode = apiCode.substring(0, removeFrom) + apiCode.substring(iifeEnd);
      fs.writeFileSync(apiPath, apiCode);
      console.log('Removed IIFE block. New file size:', (Buffer.byteLength(apiCode) / 1024).toFixed(1), 'KB');
    } else {
      console.log('IIFE does NOT contain bot_configs - checking elsewhere');
    }
  }
}

// Check if there are still bot_configs references after removal
const finalCode = fs.readFileSync(apiPath, 'utf8');
const remaining = [];
let ri = 0;
while ((ri = finalCode.indexOf('bot_configs', ri)) !== -1) {
  const ls = finalCode.lastIndexOf('\n', ri) + 1;
  const le = finalCode.indexOf('\n', ri);
  remaining.push(finalCode.substring(ls, le).trim().substring(0, 100));
  ri++;
}
console.log('\nRemaining bot_configs references:', remaining.length);
remaining.forEach((r, i) => console.log(`  ${i}: ${r}`));
