const fs = require('fs');
const filePath = 'C:\\Users\\devas\\OneDrive\\Desktop\\vartmap\\services\\unified\\src\\adminAPI.js';
let src = fs.readFileSync(filePath, 'utf8');

// ============================================
// PART 1: Add WhatsApp Nutrition Reminder Endpoint
// ============================================

const reminderEndpoint = `
  // === CROP CALENDAR REMINDER SYSTEM ===
  // Sends WhatsApp nutrition schedule reminders to farmers with upcoming stages
  app.post("/api/v1/crop-calendar/send-reminders", auth, async (req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      // Get all registrations due for reminder (today or overdue)
      const { rows: dueRegs } = await pool.query(
        \`SELECT r.id, r.farmer_id, r.crop, r.sow_date, r.land_area, r.next_reminder_date,
                f.phone, f.name, f.district_id, f.land_holding_acres, f.village
         FROM farmer_crop_registrations r
         JOIN farmers f ON f.id = r.farmer_id
         WHERE r.status = 'active'
           AND r.next_reminder_date <= $1
           AND f.phone IS NOT NULL\`,
        [today]
      );

      if (!dueRegs.length) return res.json({ sent: 0, message: 'No reminders due today' });

      const gatewayUrl = process.env.GATEWAY_URL || 'https://vartmap-whatsapp-gateway.onrender.com';
      let sent = 0, failed = 0, errors = [];

      for (const reg of dueRegs) {
        try {
          // Calculate current stage
          const sowDate = new Date(reg.sow_date);
          const daysSinceSowing = Math.floor((Date.now() - sowDate.getTime()) / (1000*60*60*24));
          
          // Get nutrition schedule for this crop
          const cropKey = reg.crop.toLowerCase();
          const schedule = NUTRITION_SCHEDULES[cropKey];
          if (!schedule) continue;

          // Find current/next stage
          let currentStage = null;
          let nextStage = null;
          for (let i = 0; i < schedule.stages.length; i++) {
            const stage = schedule.stages[i];
            if (daysSinceSowing >= stage.day_offset) {
              currentStage = stage;
              if (i + 1 < schedule.stages.length) nextStage = schedule.stages[i + 1];
            }
          }
          // If no stage passed yet, next is first
          if (!currentStage && schedule.stages.length) {
            nextStage = schedule.stages[0];
          }

          const stageToSend = nextStage || currentStage;
          if (!stageToSend) continue;

          // Get soil data for adjustments
          let soilData = null;
          if (reg.district_id) {
            const { rows: distRows } = await pool.query("SELECT district_name FROM districts_master WHERE id = $1", [reg.district_id]);
            if (distRows.length) {
              const districtName = distRows[0].district_name;
              const { rows: soilRows } = await pool.query(
                "SELECT nitrogen_low_pct, phosphorus_low_pct, potassium_low_pct, avg_ph, avg_zinc, avg_boron, avg_sulphur FROM soil_nutrient_data WHERE LOWER(district_name) ILIKE $1",
                ['%' + districtName.toLowerCase() + '%']
              );
              if (soilRows.length) {
                const avg = (rows, col) => rows.reduce((s, r) => s + (parseFloat(r[col]) || 0), 0) / rows.length;
                const nLowPct = avg(soilRows, 'nitrogen_low_pct');
                soilData = {
                  n_status: nLowPct > 50 ? 'low' : 'medium',
                  p_status: avg(soilRows, 'phosphorus_low_pct') > 50 ? 'low' : 'high',
                  k_status: avg(soilRows, 'potassium_low_pct') > 50 ? 'low' : 'high',
                  zinc_deficient_pct: 100 - avg(soilRows, 'avg_zinc'),
                  boron_deficient_pct: 100 - avg(soilRows, 'avg_boron')
                };
              }
            }
          }

          // Calculate land in hectares
          const landAcres = parseFloat(reg.land_area) || parseFloat(reg.land_holding_acres) || 1;
          const landHa = landAcres * 0.4047;

          // Build product list with adjusted doses
          let productLines = [];
          if (stageToSend.products) {
            for (const prod of stageToSend.products) {
              let dose = prod.dose_per_ha * landHa;
              let note = '';
              
              // Apply soil adjustments
              if (soilData) {
                if (prod.name.includes('Urea') && soilData.n_status === 'low') { dose *= 1.3; note = ' (N low +30%)'; }
                if ((prod.name.includes('DAP') || prod.name.includes('SSP')) && soilData.p_status === 'high') { dose *= 0.7; note = ' (P high -30%)'; }
                if (prod.name.includes('MOP') && soilData.k_status === 'high') { dose *= 0.7; note = ' (K high -30%)'; }
                if (prod.name.includes('Zinc') && soilData.zinc_deficient_pct > 50) { dose *= 1.3; note = ' (Zn deficient +30%)'; }
                if (prod.name.includes('Borax') && soilData.boron_deficient_pct > 40) { dose *= 1.25; note = ' (B deficient +25%)'; }
              }
              
              productLines.push(\`  \\u2022 \${prod.name}: \${dose.toFixed(1)} \${prod.unit}\${note}\`);
            }
          }

          // Calculate next stage date
          const nextStageDate = new Date(sowDate);
          nextStageDate.setDate(nextStageDate.getDate() + stageToSend.day_offset);
          const dateStr = nextStageDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

          // Build WhatsApp message (Hindi + English)
          const message = [
            \`\\u{1F33E} *\${reg.crop.toUpperCase()} - Khaad Schedule*\`,
            \`\\u{1F464} \${reg.name} | \${landAcres} acre\`,
            \`\`,
            \`\\u{1F4C5} *\${stageToSend.title_hi || stageToSend.title_en}*\`,
            \`Date: \${dateStr} (Day \${stageToSend.day_offset})\`,
            \`\`,
            \`\\u{1F9EA} *Products / Khaad:*\`,
            ...productLines,
            \`\`,
            stageToSend.note_hi ? \`\\u{1F4DD} \${stageToSend.note_hi}\` : '',
            \`\`,
            \`\\u{1F30D} Soil-based adjustment for your area\`,
            \`\\u{1F4F1} Full schedule: VartMap App > Fasal Calendar\`
          ].filter(l => l !== '').join('\\n');

          // Send via gateway
          const phone = reg.phone.startsWith('91') ? reg.phone : '91' + reg.phone.replace(/^\\+/, '');
          await axios.post(\`\${gatewayUrl}/api/v1/send-message\`, {
            phone: phone,
            message: message,
            session_id: 'crop-reminder',
            farmer_id: reg.farmer_id
          });

          // Log the reminder
          await pool.query(
            "INSERT INTO crop_reminders_log (registration_id, farmer_id, stage_name, message_sent) VALUES ($1, $2, $3, $4)",
            [reg.id, reg.farmer_id, stageToSend.stage, message]
          );

          // Update next_reminder_date to 7 days before next stage (or next stage date)
          let nextReminderDate = null;
          const stageIdx = schedule.stages.findIndex(s => s.stage === stageToSend.stage);
          if (stageIdx > -1 && stageIdx + 1 < schedule.stages.length) {
            const upcoming = schedule.stages[stageIdx + 1];
            const upcomingDate = new Date(sowDate);
            upcomingDate.setDate(upcomingDate.getDate() + upcoming.day_offset - 7);
            nextReminderDate = upcomingDate.toISOString().split('T')[0];
          }
          
          await pool.query(
            "UPDATE farmer_crop_registrations SET next_reminder_date = $1, updated_at = NOW() WHERE id = $2",
            [nextReminderDate, reg.id]
          );

          sent++;
        } catch (err) {
          failed++;
          errors.push({ reg_id: reg.id, error: err.message });
        }
      }

      res.json({ 
        sent, failed, total_due: dueRegs.length, 
        errors: errors.slice(0, 5),
        note: 'Reminders sent with soil-adjusted doses via WhatsApp'
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual trigger: Send nutrition schedule to specific farmer
  app.post("/api/v1/crop-calendar/send-schedule/:registrationId", auth, async (req, res) => {
    try {
      const { registrationId } = req.params;
      const { rows } = await pool.query(
        \`SELECT r.*, f.phone, f.name FROM farmer_crop_registrations r
         JOIN farmers f ON f.id = r.farmer_id WHERE r.id = $1\`,
        [registrationId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Registration not found' });
      
      const reg = rows[0];
      if (!reg.phone) return res.status(400).json({ error: 'Farmer has no phone number' });

      // Fetch full nutrition schedule from our own endpoint
      const scheduleUrl = \`http://localhost:\${PORT}/api/v1/crop-calendar/nutrition-schedule/\${registrationId}\`;
      const schedResp = await axios.get(scheduleUrl);
      const sched = schedResp.data;

      // Build comprehensive WhatsApp message
      let lines = [
        \`\\u{1F33E} *\${reg.crop.toUpperCase()} - Full Khaad Schedule*\`,
        \`\\u{1F464} \${reg.name} | \${sched.registration.land_acres} acre\`,
        \`\\u{1F30D} District: \${sched.farmer.district} | Soil N: \${sched.soil_data?.nitrogen || 'N/A'}\\n\`,
      ];

      for (const stage of sched.schedule) {
        const status = stage.status === 'completed' ? '\\u2705' : stage.status === 'pending' ? '\\u23F3' : '\\u{1F534}';
        lines.push(\`\${status} *\${stage.title_hi || stage.title_en}* (Day \${stage.day_offset} - \${stage.scheduled_date})\`);
        if (stage.products) {
          for (const p of stage.products) {
            lines.push(\`   \\u2022 \${p.name}: \${p.adjusted_dose} \${p.unit}\${p.soil_note ? ' [' + p.soil_note + ']' : ''}\`);
          }
        }
        lines.push('');
      }
      lines.push(\`\\u{1F4F1} VartMap App pe dekhein: Fasal Calendar > \${reg.crop}\`);

      const message = lines.join('\\n');
      const phone = reg.phone.startsWith('91') ? reg.phone : '91' + reg.phone.replace(/^\\+/, '');
      const gatewayUrl = process.env.GATEWAY_URL || 'https://vartmap-whatsapp-gateway.onrender.com';
      
      await axios.post(\`\${gatewayUrl}/api/v1/send-message\`, {
        phone, message, session_id: 'manual-schedule', farmer_id: reg.farmer_id
      });

      res.json({ sent: true, phone, message_length: message.length, stages: sched.schedule.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
`;

// Find insertion point - before the init-tables or before the last app.listen
const insertBefore = src.indexOf('// --- CROP CALENDAR API ROUTES ---');
let insertPoint;
if (insertBefore > -1) {
  // Insert right after the crop calendar tables are created, before the routes
  const afterTables = src.indexOf('app.get("/api/v1/crop-calendar/templates"');
  insertPoint = afterTables > -1 ? afterTables : insertBefore;
} else {
  // Fallback: insert before list-districts
  insertPoint = src.indexOf('app.get("/api/v1/crop-calendar/list-districts"');
}

if (insertPoint === -1) {
  // Last resort: find any crop-calendar endpoint
  insertPoint = src.indexOf('/api/v1/crop-calendar/nutrition-schedule');
  insertPoint = src.lastIndexOf('\n', insertPoint - 200);
}

console.log(\`Inserting reminder endpoints at offset \${insertPoint}\`);
src = src.substring(0, insertPoint) + reminderEndpoint + '\n\n  ' + src.substring(insertPoint);

// Write and verify
fs.writeFileSync(filePath, src, 'utf8');
console.log(\`File size: \${(src.length / 1024).toFixed(1)} KB\`);

const { execSync } = require('child_process');
try {
  execSync(\`node --check "\${filePath}"\`, { stdio: 'pipe' });
  console.log('Syntax check PASSED');
} catch (e) {
  console.log('Syntax check FAILED:');
  console.log(e.stderr.toString().substring(0, 800));
}

// Verify endpoints exist
const final = fs.readFileSync(filePath, 'utf8');
console.log('\\n=== New endpoints verification ===');
console.log(\`  send-reminders: \${final.includes('send-reminders') ? 'FOUND' : 'MISSING'}\`);
console.log(\`  send-schedule/:registrationId: \${final.includes('send-schedule') ? 'FOUND' : 'MISSING'}\`);
console.log(\`  Total /api/v1/crop-calendar endpoints: \${(final.match(/\\/api\\/v1\\/crop-calendar/g) || []).length}\`);
