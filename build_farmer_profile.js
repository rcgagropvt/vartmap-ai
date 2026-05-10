const fs = require('fs');

// ===== STEP 1: Add API endpoints =====
const apiFile = 'C:/Users/devas/OneDrive/Desktop/vartmap/services/unified/src/adminAPI.js';
let api = fs.readFileSync(apiFile, 'utf8');

// Check if already added
if (api.includes('full-profile')) {
  console.log('API: full-profile endpoint already exists, skipping');
} else {
  const endpoint = [];
  endpoint.push('');
  endpoint.push('  // ===== COMPREHENSIVE FARMER PROFILE =====');
  endpoint.push('  app.get("/api/v1/farmers/:id/full-profile", auth, async (req, res) => {');
  endpoint.push('    try {');
  endpoint.push('      const { id } = req.params;');
  endpoint.push('      const { rows: fr } = await pool.query("SELECT * FROM farmers WHERE id=", [id]);');
  endpoint.push('      if (!fr[0]) return res.status(404).json({ error: "Farmer not found" });');
  endpoint.push('      const farmer = fr[0];');
  endpoint.push('      const msgs = await pool.query("SELECT * FROM wa_messages WHERE farmer_id= ORDER BY created_at DESC LIMIT 50", [id]).then(r=>r.rows).catch(()=>[]);');
  endpoint.push('      const posts = await pool.query("SELECT * FROM community_posts WHERE farmer_id= ORDER BY created_at DESC LIMIT 20", [id]).then(r=>r.rows).catch(()=>[]);');
  endpoint.push('      const diagnoses = await pool.query("SELECT * FROM wa_messages WHERE farmer_id= AND (content ILIKE \'%diagnos%\' OR content ILIKE \'%disease%\' OR content ILIKE \'%pest%\' OR content ILIKE \'%treatment%\') ORDER BY created_at DESC LIMIT 20", [id]).then(r=>r.rows).catch(()=>[]);');
  endpoint.push('      const txns = await pool.query("SELECT * FROM farm_transactions WHERE farmer_id= ORDER BY date DESC LIMIT 50", [id]).then(r=>r.rows).catch(()=>[]);');
  endpoint.push('      const finRes = await pool.query("SELECT COALESCE(SUM(CASE WHEN type=\'income\' THEN amount ELSE 0 END),0) as total_income, COALESCE(SUM(CASE WHEN type=\'expense\' THEN amount ELSE 0 END),0) as total_expense, COUNT(*) as total_entries FROM farm_transactions WHERE farmer_id=", [id]).catch(()=>({rows:[{total_income:0,total_expense:0,total_entries:0}]}));');
  endpoint.push('      const monthlyFin = await pool.query("SELECT TO_CHAR(date,\'YYYY-MM\') as month, COALESCE(SUM(CASE WHEN type=\'income\' THEN amount ELSE 0 END),0) as income, COALESCE(SUM(CASE WHEN type=\'expense\' THEN amount ELSE 0 END),0) as expense FROM farm_transactions WHERE farmer_id= AND date >= NOW()-INTERVAL \'6 months\' GROUP BY TO_CHAR(date,\'YYYY-MM\') ORDER BY month", [id]).then(r=>r.rows).catch(()=>[]);');
  endpoint.push('      const expByCat = await pool.query("SELECT category, SUM(amount) as total FROM farm_transactions WHERE farmer_id= AND type=\'expense\' GROUP BY category ORDER BY total DESC LIMIT 10", [id]).then(r=>r.rows).catch(()=>[]);');
  endpoint.push('      const loyalty = await pool.query("SELECT * FROM farmer_loyalty WHERE farmer_id=", [id]).then(r=>r.rows[0]||null).catch(()=>null);');
  endpoint.push('      const spins = await pool.query("SELECT * FROM spin_results WHERE farmer_id= ORDER BY created_at DESC LIMIT 10", [id]).then(r=>r.rows).catch(()=>[]);');
  endpoint.push('      const iStats = await pool.query("SELECT COUNT(*) as total_messages, COUNT(CASE WHEN direction=\'inbound\' THEN 1 END) as inbound, COUNT(CASE WHEN direction=\'outbound\' THEN 1 END) as outbound FROM wa_messages WHERE farmer_id=", [id]).then(r=>r.rows[0]).catch(()=>({total_messages:0,inbound:0,outbound:0}));');
  endpoint.push('      const reels = await pool.query("SELECT * FROM reels WHERE farmer_id= ORDER BY created_at DESC LIMIT 10", [id]).then(r=>r.rows).catch(()=>[]);');
  endpoint.push('      res.json({farmer, messages:msgs, posts, diagnoses, transactions:txns, financeSummary:finRes.rows[0], monthlyFinance:monthlyFin, expenseByCategory:expByCat, loyalty, spins, interactionStats:iStats, reelActivity:reels});');
  endpoint.push('    } catch(e) { console.error(e); res.status(500).json({error:e.message}); }');
  endpoint.push('  });');
  endpoint.push('');
  endpoint.push('  // AI Summary');
  endpoint.push('  app.post("/api/v1/farmers/:id/ai-summary", auth, async (req, res) => {');
  endpoint.push('    try {');
  endpoint.push('      const { profileData } = req.body;');
  endpoint.push('      const { GoogleGenerativeAI } = require("@google/generative-ai");');
  endpoint.push('      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);');
  endpoint.push('      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });');
  endpoint.push('      const prompt = "You are an agricultural analyst for VartMap (Indian agri-tech). Analyze this farmer data. Give 4-5 paragraph summary: 1)Overview 2)Farming activities 3)Financial health 4)Communication 5)Recommendations. Under 300 words. Data: " + JSON.stringify(profileData);');
  endpoint.push('      const result = await model.generateContent(prompt);');
  endpoint.push('      res.json({ summary: result.response.text() });');
  endpoint.push('    } catch(e) { res.json({ summary: "Unable to generate summary: " + e.message }); }');
  endpoint.push('  });');
  endpoint.push('');

  const insertPt = api.lastIndexOf('};');
  api = api.slice(0, insertPt) + endpoint.join('\n') + '\n};';
  fs.writeFileSync(apiFile, api);
  console.log('API: Added full-profile + ai-summary endpoints');
}

// ===== STEP 2: Update HTML =====
const htmlFile = 'C:/Users/devas/OneDrive/Desktop/vartmap/services/unified/public/index.html';
let html = fs.readFileSync(htmlFile, 'utf8');

// Add Chart.js
if (!html.includes('chart.js') && !html.includes('Chart.js')) {
  html = html.replace('</head>', '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"><\/script>\n</head>');
  console.log('HTML: Added Chart.js CDN');
}

// Find viewFarmer
const fnStart = html.indexOf('async function viewFarmer(id) {');
if (fnStart === -1) { console.log('ERROR: viewFarmer not found'); process.exit(1); }

let bc = 0, fe = fnStart, st = false;
for (let i = fnStart; i < html.length; i++) {
  if (html[i] === '{') { bc++; st = true; }
  if (html[i] === '}') { bc--; }
  if (st && bc === 0) { fe = i + 1; break; }
}

// New viewFarmer - uses backtick template that runs CLIENT SIDE
const newViewFarmer = fs.readFileSync('farmer_detail_fn.js', 'utf8');
html = html.slice(0, fnStart) + newViewFarmer + html.slice(fe);
fs.writeFileSync(htmlFile, html);
console.log('HTML: Replaced viewFarmer, file size:', (Buffer.byteLength(html)/1024).toFixed(1), 'KB');
