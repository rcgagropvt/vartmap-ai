const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const appDir = 'C:\\Users\\devas\\OneDrive\\Desktop\\vartmap-farmer-app';

// List src directory structure
try {
  const result = execSync('dir /s /b "' + appDir + '\\src\\*.tsx" "' + appDir + '\\src\\*.ts"', { encoding: 'utf8' });
  console.log('=== TSX/TS files ===');
  console.log(result);
} catch(e) {
  // Try alternative
  try {
    const result = execSync('dir /s /b "' + appDir + '\\*.tsx" "' + appDir + '\\*.ts"', { encoding: 'utf8' });
    console.log('=== All TSX/TS files ===');
    console.log(result.substring(0, 3000));
  } catch(e2) {
    console.log('Error:', e2.message);
  }
}

// Check if there's already a calendar screen
try {
  const calFiles = execSync('dir /s /b "' + appDir + '\\*calendar*" "' + appDir + '\\*Calendar*"', { encoding: 'utf8' });
  console.log('\n=== Calendar files ===');
  console.log(calFiles);
} catch(e) {
  console.log('No calendar files found yet');
}

// Check api.ts
try {
  const apiFiles = execSync('dir /s /b "' + appDir + '\\*api*"', { encoding: 'utf8' });
  console.log('\n=== API files ===');
  console.log(apiFiles);
} catch(e) {}

// Check app navigation/routes
try {
  const navFiles = execSync('dir /s /b "' + appDir + '\\*nav*" "' + appDir + '\\*route*" "' + appDir + '\\*App*"', { encoding: 'utf8' });
  console.log('\n=== Navigation files ===');
  console.log(navFiles);
} catch(e) {}
