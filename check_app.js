const fs = require('fs');
const path = require('path');

// Check farmer app structure
const appDir = path.join(__dirname, 'services', 'unified', 'farmer-app', 'src');
const altDir = path.join(__dirname, 'farmer-app', 'src');
const altDir2 = path.join(__dirname, 'apps', 'farmer');

let baseDir = '';
if (fs.existsSync(appDir)) baseDir = appDir;
else if (fs.existsSync(altDir)) baseDir = altDir;
else if (fs.existsSync(altDir2)) baseDir = altDir2;
else {
  // Search for calendar.tsx or any farmer app files
  const { execSync } = require('child_process');
  try {
    const result = execSync('dir /s /b C:\\Users\\devas\\OneDrive\\Desktop\\vartmap\\*calendar*', { encoding: 'utf8' });
    console.log('Calendar files found:\n', result);
  } catch(e) {
    console.log('No calendar files found');
  }
  try {
    const result2 = execSync('dir /s /b C:\\Users\\devas\\OneDrive\\Desktop\\vartmap\\*farmer*app*', { encoding: 'utf8' });
    console.log('\nFarmer app dirs:\n', result2.substring(0, 2000));
  } catch(e) {}
  try {
    const result3 = execSync('dir /s /b C:\\Users\\devas\\OneDrive\\Desktop\\vartmap\\src\\*.tsx', { encoding: 'utf8' });
    console.log('\nTSX files:\n', result3.substring(0, 2000));
  } catch(e) {}
}

if (baseDir) {
  console.log('App dir:', baseDir);
  const files = fs.readdirSync(baseDir, { recursive: true });
  console.log('Files:', files.filter(f => f.endsWith('.tsx') || f.endsWith('.ts')).join('\n'));
}

// Check api.ts for existing endpoints
try {
  const { execSync } = require('child_process');
  const apiFile = execSync('dir /s /b C:\\Users\\devas\\OneDrive\\Desktop\\vartmap\\*api.ts', { encoding: 'utf8' });
  console.log('\nAPI files:\n', apiFile);
} catch(e) {}
