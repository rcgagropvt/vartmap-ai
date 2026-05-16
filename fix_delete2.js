const fs = require('fs');
const adminPath = 'C:\\Users\\devas\\OneDrive\\Desktop\\vartmap\\services\\unified\\src\\adminAPI.js';
let code = fs.readFileSync(adminPath, 'utf8');

// Find the last route's closing ");", insert after it
const lastPost = code.lastIndexOf('app.post(');
let braceCount = 0, started = false, routeEnd = lastPost;
for (let i = lastPost; i < code.length; i++) {
  if (code[i] === '{') { braceCount++; started = true; }
  if (code[i] === '}') { braceCount--; }
  if (started && braceCount === 0) { routeEnd = i + 1; break; }
}
const closeParen = code.indexOf(');', routeEnd);
const insertAt = closeParen + 2;

const endpoint = `

  // TEMP: Delete farmer by phone (for testing)
  app.delete('/api/v1/admin/delete-farmer/:phone', async (req, res) => {
    try {
      const phone = req.params.phone.replace(/[^0-9]/g, '');
      const r1 = await pool.query("DELETE FROM farmer_otps WHERE phone LIKE '%' || $1 || '%'", [phone]);
      const r2 = await pool.query("DELETE FROM farmers WHERE phone LIKE '%' || $1 || '%' RETURNING *", [phone]);
      res.json({ deleted: r2.rowCount, otps_cleared: r1.rowCount, farmer: r2.rows[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
`;

code = code.substring(0, insertAt) + endpoint + code.substring(insertAt);
fs.writeFileSync(adminPath, code);
console.log('Inserted at:', insertAt);
console.log('File size:', (code.length / 1024).toFixed(1), 'KB');

// Verify context
console.log('Context around insert:');
console.log(code.substring(insertAt - 10, insertAt + endpoint.length + 30));

const { execSync } = require('child_process');
try {
  execSync('node --check "' + adminPath + '"');
  console.log('Syntax check: PASSED');
} catch(e) {
  console.log('Syntax check: FAILED');
  console.log(e.stderr?.toString());
}

try { fs.unlinkSync('C:\\Users\\devas\\OneDrive\\Desktop\\vartmap\\find_spot.js'); } catch(e) {}
