const fs = require('fs');
const path = require('path');

const gwPath = path.join(__dirname, 'services', 'unified', 'src', 'gateway.js');
let gwCode = fs.readFileSync(gwPath, 'utf8');

// Find the sendMenuMessage function and fix it to split items into sections of 10
const funcStart = gwCode.indexOf('function sendMenuMessage(to, botConfig, language)');
if (funcStart === -1) {
  console.log('ERROR: sendMenuMessage not found');
  process.exit(1);
}

// Find the end of the function
let braces = 0;
let started = false;
let funcEnd = -1;
for (let i = funcStart; i < gwCode.length; i++) {
  if (gwCode[i] === '{') { braces++; started = true; }
  if (gwCode[i] === '}') { braces--; }
  if (started && braces === 0) {
    funcEnd = i + 1;
    break;
  }
}

console.log('sendMenuMessage from char', funcStart, 'to', funcEnd);
console.log('Current function:\n', gwCode.substring(funcStart, funcEnd));

// Replace with a version that splits into sections of max 10
const newFunc = `function sendMenuMessage(to, botConfig, language) {
  const items = (botConfig.menu_items || [])
    .filter(m => m.is_active !== false)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  if (items.length === 0) {
    return; // No menu configured, AI will handle freely
  }

  if (items.length <= 3) {
    // Use buttons for 1-3 items
    const buttons = items.map(m => ({
      id: m.menu_key || m.id,
      title: (language === 'hi' ? (m.title_hi || m.title_en) : (m.title_en || m.title_hi)).substring(0, 20)
    }));
    const bodyText = language === 'hi' ? (botConfig.menu_hi || 'Aap neeche diye gaye options mein se choose kar sakte hain:') : (botConfig.menu_en || 'You can choose from the options below:');
    return sendWhatsAppButtons(to, bodyText, buttons);
  } else {
    // Use list - WhatsApp allows max 10 rows per section
    const rows = items.map(m => ({
      id: m.menu_key || m.id,
      title: (language === 'hi' ? (m.title_hi || m.title_en) : (m.title_en || m.title_hi)).substring(0, 24),
      description: (language === 'hi' ? (m.description_hi || m.description_en || '') : (m.description_en || m.description_hi || '')).substring(0, 72)
    }));
    
    // Split into sections of max 10
    const sections = [];
    for (let i = 0; i < rows.length; i += 10) {
      const chunk = rows.slice(i, i + 10);
      sections.push({
        title: sections.length === 0 ? (language === 'hi' ? 'Services' : 'Services') : (language === 'hi' ? 'Aur Options' : 'More Options'),
        rows: chunk
      });
    }
    
    const bodyText2 = language === 'hi' ? (botConfig.menu_hi || 'Aap neeche diye gaye options mein se choose kar sakte hain:') : (botConfig.menu_en || 'You can choose from the options below:');
    return sendWhatsAppList(to, bodyText2, 'Options', sections);
  }
}`;

gwCode = gwCode.substring(0, funcStart) + newFunc + gwCode.substring(funcEnd);
fs.writeFileSync(gwPath, gwCode);
console.log('\nReplaced sendMenuMessage with section-split version');
console.log('File size:', (Buffer.byteLength(gwCode) / 1024).toFixed(1), 'KB');
