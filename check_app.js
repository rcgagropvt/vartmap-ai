const fs = require('fs');
const appDir = 'C:\\Users\\devas\\OneDrive\\Desktop\\vartmap-farmer-app\\app';

// Check what files exist
const files = fs.readdirSync(appDir).filter(f => f.endsWith('.tsx') || f.endsWith('.ts'));
console.log('App screens:');
files.forEach(f => {
  const size = fs.statSync(appDir + '\\' + f).size;
  console.log(' ', f, '(' + (size / 1024).toFixed(1) + ' KB)');
});

// Check precision-inputs.tsx
const piPath = appDir + '\\precision-inputs.tsx';
if (fs.existsSync(piPath)) {
  const pi = fs.readFileSync(piPath, 'utf8');
  console.log('\nprecision-inputs.tsx exists:', pi.length, 'chars');
  console.log('First 300 chars:', pi.substring(0, 300));
} else {
  console.log('\nprecision-inputs.tsx: NOT FOUND');
}

// Check nutrition-schedule.tsx for Smart Settings button
const nsPath = appDir + '\\nutrition-schedule.tsx';
if (fs.existsSync(nsPath)) {
  const ns = fs.readFileSync(nsPath, 'utf8');
  console.log('\nnutrition-schedule.tsx:', ns.length, 'chars');
  
  // Check for Smart Settings button
  const smartBtn = ns.indexOf('Smart');
  console.log('Smart button:', smartBtn !== -1 ? 'FOUND' : 'NOT FOUND');
  
  // Check params
  const params = ns.match(/useLocalSearchParams/g);
  console.log('useLocalSearchParams:', params ? params.length + ' refs' : 'none');
  
  // Check what param names are used
  const paramDestructure = ns.match(/const\s*\{([^}]+)\}\s*=\s*useLocalSearchParams/);
  console.log('Params:', paramDestructure ? paramDestructure[1].trim() : 'not found');
  
  // Check fetch pattern
  const fetchPattern = ns.match(/NutritionSchedule\((\w+)/);
  console.log('Fetch uses:', fetchPattern ? fetchPattern[1] : 'not found');
  
  // Check router
  const routerImport = ns.indexOf('router');
  console.log('router imported:', routerImport !== -1);
}

// Check lib/api.ts for precision endpoints
const apiPath = 'C:\\Users\\devas\\OneDrive\\Desktop\\vartmap-farmer-app\\lib\\api.ts';
if (fs.existsSync(apiPath)) {
  const api = fs.readFileSync(apiPath, 'utf8');
  const checks = ['yield-target', 'water-quality', 'soil-test', 'precision', 'nutrition-schedule'];
  console.log('\nlib/api.ts endpoints:');
  checks.forEach(c => {
    console.log(' ', c, ':', api.includes(c) ? 'FOUND' : 'NOT FOUND');
  });
}
