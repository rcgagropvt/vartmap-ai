const fs = require('fs');
const path = require('path');

// ===== PART 1: Add table creation to adminAPI.js =====
const apiPath = path.join(__dirname, 'services', 'unified', 'src', 'adminAPI.js');
let apiCode = fs.readFileSync(apiPath, 'utf8');

// Check if table creation already exists
if (apiCode.includes('CREATE TABLE IF NOT EXISTS crop_calendar_templates')) {
  console.log('Table creation already exists in adminAPI.js');
} else {
  // Find the crop-calendar register endpoint and add table init before it
  const marker = '// Register farmer crop (from app or bot)';
  const markerIdx = apiCode.indexOf(marker);
  
  if (markerIdx === -1) {
    console.log('ERROR: Could not find register marker');
    process.exit(1);
  }

  // Find a good place to add init - look for the initDB or pool.query CREATE TABLE section
  // Add a self-executing table creation block near the top of crop calendar section
  const cropCalStart = apiCode.indexOf('/api/v1/crop-calendar');
  const firstCropRoute = apiCode.lastIndexOf('app.', cropCalStart);
  const insertPoint = apiCode.lastIndexOf('\n', firstCropRoute);

  const tableInit = `
  // ===== CROP CALENDAR TABLE INIT =====
  (async () => {
    try {
      await pool.query(\`
        CREATE TABLE IF NOT EXISTS crop_calendar_templates (
          id SERIAL PRIMARY KEY,
          crop VARCHAR(100) NOT NULL,
          stage_name VARCHAR(200) NOT NULL,
          day_offset INTEGER NOT NULL,
          message_hi TEXT,
          message_en TEXT,
          activity TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS farmer_crop_registrations (
          id SERIAL PRIMARY KEY,
          farmer_id UUID REFERENCES farmers(id),
          crop VARCHAR(100) NOT NULL,
          sow_date DATE NOT NULL,
          land_area DECIMAL,
          next_reminder_date DATE,
          status VARCHAR(20) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS crop_reminders_log (
          id SERIAL PRIMARY KEY,
          registration_id INTEGER REFERENCES farmer_crop_registrations(id),
          farmer_id UUID REFERENCES farmers(id),
          stage_name VARCHAR(200),
          message_sent TEXT,
          sent_at TIMESTAMP DEFAULT NOW()
        );
      \`);
      
      // Seed default templates if empty
      const { rows } = await pool.query("SELECT COUNT(*) as cnt FROM crop_calendar_templates");
      if (parseInt(rows[0].cnt) === 0) {
        const seeds = [
          ['wheat', 'Beej Upchar (Seed Treatment)', 0, 'Gehu ke beej ko Bavistin 2g/kg se upcharit karein. Isse fungal rog se bachav hota hai.', 'Treat wheat seeds with Bavistin 2g/kg before sowing to prevent fungal diseases.', 'seed_treatment'],
          ['wheat', 'Pehli Sinchai (First Irrigation)', 21, 'Gehu mein pehli sinchai 21 din baad karein (Crown Root stage). Deri se paidavar ghatti hai.', 'First irrigation at 21 days (Crown Root stage). Delay reduces yield significantly.', 'irrigation'],
          ['wheat', 'Kharpatwar Niyantran (Weed Control)', 30, 'Ab kharpatwar hatane ka samay hai. Sulfosulfuron 25g/ha spray karein ya haath se nirai karein.', 'Time for weed control. Spray Sulfosulfuron 25g/ha or do manual weeding.', 'weed_control'],
          ['wheat', 'Doosri Sinchai (2nd Irrigation)', 42, 'Doosri sinchai 40-45 din par karein (Tillering stage). Urea 1/3 bhi dalein.', 'Second irrigation at 40-45 days (Tillering stage). Apply 1/3 Urea top dressing.', 'irrigation'],
          ['wheat', 'Teesri Sinchai (3rd Irrigation)', 65, 'Teesri sinchai 60-65 din par (Late Jointing). Potash spray se dane bhari honge.', 'Third irrigation at 60-65 days (Late Jointing). Potash spray helps grain filling.', 'irrigation'],
          ['wheat', 'Rog Nighrani (Disease Watch)', 75, 'Peelay/bhure dhabe dikhein? Ye rust ho sakta hai. Propiconazole 0.1% spray karein.', 'Seeing yellow/brown spots? Could be rust. Spray Propiconazole 0.1% immediately.', 'disease_watch'],
          ['wheat', 'Chauthi Sinchai (4th Irrigation)', 85, 'Chauthi sinchai 80-85 din (Flowering). Doodh stage mein pani zaroori hai.', 'Fourth irrigation at 80-85 days (Flowering/Milking stage). Critical for grain development.', 'irrigation'],
          ['wheat', 'Katai Taiyari (Harvest Prep)', 115, 'Gehu 115-120 din mein taiyar. Dane sakht ho jayein aur nami 14% ho to katai karein.', 'Wheat ready in 115-120 days. Harvest when grains are hard and moisture is below 14%.', 'harvest'],
          ['rice', 'Nursery Taiyari', 0, 'Dhaan ki nursery taiyar karein. Beej ko 24 ghante pani mein bhigoye rakhein.', 'Prepare rice nursery. Soak seeds in water for 24 hours before sowing.', 'nursery'],
          ['rice', 'Ropai (Transplanting)', 25, 'Ab 25-30 din ki paudh ropai ke liye taiyar hai. 2-3 paudh/hill, 20x15cm spacing rakhein.', 'Seedlings ready for transplanting at 25-30 days. Use 2-3 seedlings/hill, 20x15cm spacing.', 'transplanting'],
          ['rice', 'Kharpatwar Niyantran', 35, 'Ropai ke 7-10 din baad Butachlor 1.5kg/ha dalein ya haath se nirai karein.', 'Apply Butachlor 1.5kg/ha within 7-10 days of transplanting or do manual weeding.', 'weed_control'],
          ['rice', 'Urea Top Dressing', 45, 'Ropai ke 20 din baad Urea ka pehla top dressing karein (1/3 maatra).', 'First Urea top dressing 20 days after transplanting (1/3 dose).', 'fertilizer'],
          ['rice', 'Keetnashak Spray', 55, 'Tane ka borer ya patte ka mahodar dikhe to Cartap/Chlorantraniliprole spray karein.', 'If stem borer or leaf folder spotted, spray Cartap/Chlorantraniliprole.', 'pest_control'],
          ['rice', 'Doosra Top Dressing', 65, 'Ropai ke 40 din par doosra Urea top dressing (1/3 maatra). Paani bhar ke rakhein.', 'Second Urea top dressing at 40 days after transplanting. Maintain 5cm standing water.', 'fertilizer'],
          ['rice', 'Flowering Dekhbhal', 85, 'Phool aane ka samay. Paani ki kami na ho. Rog dikhe to Tricyclazole spray karein.', 'Flowering stage - ensure no water stress. Spray Tricyclazole if blast symptoms appear.', 'flowering_care'],
          ['rice', 'Katai (Harvest)', 120, 'Dhaan 120-135 din mein taiyar. 80% dane golden ho jayein tab katai karein.', 'Rice ready in 120-135 days. Harvest when 80% grains turn golden.', 'harvest'],
          ['sugarcane', 'Ropai/Buwai', 0, 'Ganna sets ko Bavistin se upcharit karein. 90cm row spacing, 30cm depth mein lagayein.', 'Treat sugarcane sets with Bavistin. Plant at 90cm row spacing, 30cm depth.', 'planting'],
          ['sugarcane', 'Pehli Sinchai', 7, 'Buwai ke 7 din baad halki sinchai dein. Mitti mein nami banaaye rakhein.', 'Light irrigation 7 days after planting. Maintain soil moisture.', 'irrigation'],
          ['sugarcane', 'Kharpatwar + Mitti Chadhana (1st)', 45, 'Pehla kharpatwar niyantran aur halka mitti chadhana karein. Atrazine spray bhi kar sakte hain.', 'First weeding and light earthing up. Can also spray Atrazine pre-emergence.', 'earthing_up'],
          ['sugarcane', 'Doosra Mitti Chadhana', 90, 'Doosra bhaari mitti chadhana karein. Ye tillers ko support deta hai. Urea bhi dalein.', 'Heavy earthing up at 90 days. Supports tillers. Apply Urea top dressing.', 'earthing_up'],
          ['sugarcane', 'Borer Niyantran', 120, 'Tane ke borer ki jaanch karein. Agar 5%+ infestation ho to Coragen spray karein.', 'Check for stem borer. If >5% infestation, spray Coragen/Chlorantraniliprole.', 'pest_control'],
          ['sugarcane', 'Grand Growth Dekhbhal', 180, 'Grand growth phase mein niyamit sinchai (15 din) zaroori hai. Potash bhi daalein.', 'Regular irrigation every 15 days critical during grand growth. Apply Potash.', 'growth_care'],
          ['sugarcane', 'Pakkne ka Samay', 300, 'Ganna pak raha hai. Sinchai band karein. Ripener spray karna chahein to kar sakte hain.', 'Cane maturing. Stop irrigation. Optional: apply ripener spray for better sugar recovery.', 'maturation'],
          ['sugarcane', 'Katai (Harvest)', 330, 'Ganna 11-12 mahine mein taiyar. Zameen ke paas se kaatein. Jaldi mill bhejein.', 'Sugarcane ready in 11-12 months. Cut close to ground. Send to mill within 24 hours.', 'harvest']
        ];
        
        for (const s of seeds) {
          await pool.query(
            "INSERT INTO crop_calendar_templates (crop, stage_name, day_offset, message_hi, message_en, activity) VALUES ($1,$2,$3,$4,$5,$6)",
            s
          );
        }
        console.log("Seeded " + seeds.length + " crop calendar templates");
      }
    } catch(e) {
      console.error("Crop calendar table init error:", e.message);
    }
  })();

`;

  apiCode = apiCode.substring(0, insertPoint) + '\n' + tableInit + apiCode.substring(insertPoint);
  fs.writeFileSync(apiPath, apiCode);
  console.log('Added table creation + seeding to adminAPI.js');
}

// ===== PART 2: Add Fasal Calendar menu item =====
// The menu is loaded from botConfig.menu_items which comes from the database (bot_configs table)
// We need to add an API call that inserts the menu item, OR we can add it to the gateway init

const gwPath = path.join(__dirname, 'services', 'unified', 'src', 'gateway.js');
let gwCode = fs.readFileSync(gwPath, 'utf8');

// Find where botConfig is loaded/cached and add fasal calendar menu item insertion
// Better approach: Add it as a DB migration in adminAPI.js
if (apiCode.includes('fasal_calendar')) {
  console.log('Fasal calendar menu item already referenced');
} else {
  // Add menu item seeding after table creation
  let apiCode2 = fs.readFileSync(apiPath, 'utf8');
  
  // Find the end of the crop calendar table init IIFE
  const seedMarker = 'Seeded " + seeds.length + " crop calendar templates';
  const seedIdx = apiCode2.indexOf(seedMarker);
  if (seedIdx !== -1) {
    // Find the closing of the try-catch after seeding
    const afterSeed = apiCode2.indexOf('} catch(e) {\n      console.error("Crop calendar table init error"', seedIdx);
    if (afterSeed !== -1) {
      const menuInsert = `
      // Add Fasal Calendar to menu if not exists
      try {
        const { rows: configs } = await pool.query("SELECT id, menu_items FROM bot_configs LIMIT 1");
        if (configs.length > 0) {
          let menuItems = configs[0].menu_items || [];
          if (typeof menuItems === 'string') menuItems = JSON.parse(menuItems);
          const hasFasal = menuItems.some(m => m.menu_key === 'fasal_calendar');
          if (!hasFasal) {
            menuItems.push({
              menu_key: 'fasal_calendar',
              title_hi: 'Fasal Calendar',
              title_en: 'Crop Calendar',
              description_hi: 'Fasal register karein, reminders paayein',
              description_en: 'Register crop & get growth stage reminders',
              is_active: true,
              sort_order: menuItems.length + 1
            });
            await pool.query("UPDATE bot_configs SET menu_items=$1 WHERE id=$2", [JSON.stringify(menuItems), configs[0].id]);
            console.log("Added Fasal Calendar to menu");
          }
        }
      } catch(e2) { console.error("Menu item add error:", e2.message); }

`;
      apiCode2 = apiCode2.substring(0, afterSeed) + menuInsert + apiCode2.substring(afterSeed);
      fs.writeFileSync(apiPath, apiCode2);
      console.log('Added Fasal Calendar menu item seeding');
    } else {
      console.log('Could not find catch block after seeding - adding menu item separately');
    }
  } else {
    console.log('Seed marker not found - table init may already have existed');
  }
}

// ===== PART 3: Handle "fasal_calendar" menu_key in gateway.js =====
// When user clicks the menu item, it sends the menu_key as interactive message
// Check if the gateway handles 'fasal_calendar' interactive selection

if (gwCode.includes('fasal_calendar')) {
  console.log('fasal_calendar handler already exists in gateway.js');
} else {
  // Find where other menu keys are handled (like mandi, govt_schemes)
  const flowHandlerIdx = gwCode.indexOf('handleFlow');
  if (flowHandlerIdx !== -1) {
    // Find the function definition
    const funcDef = gwCode.indexOf('async function handleFlow');
    if (funcDef !== -1) {
      // Find the switch/if block inside handleFlow
      const flowBody = gwCode.substring(funcDef, funcDef + 3000);
      console.log('\nChecking handleFlow for menu key handling...');
      
      // Look for where interactive messages route to handleFlow
      // The fasal_calendar key should trigger the same as "fasal register"
      // Find where crop calendar commands are in main handler
      const cropCmdIdx = gwCode.indexOf('fasal register');
      if (cropCmdIdx !== -1) {
        console.log('Found "fasal register" handler at char:', cropCmdIdx);
        
        // Add fasal_calendar interactive key handling near the crop calendar commands
        // Find the block that checks for interactive messages and routes them
        const interactiveIdx = gwCode.indexOf("messageType === 'interactive'");
        if (interactiveIdx !== -1) {
          console.log('Found interactive check at char:', interactiveIdx);
          
          // Find where interactive list_reply IDs are handled
          // Add fasal_calendar to the main handler section where crop commands are
          // The simplest fix: in the main handler where we check for "fasal register" etc, also check for interactive id === 'fasal_calendar'
          
          // Find the exact crop calendar command block
          const cropBlock = gwCode.substring(cropCmdIdx - 200, cropCmdIdx + 500);
          const cropLines = cropBlock.split('\n');
          console.log('\nCrop calendar trigger context:');
          cropLines.slice(0, 15).forEach((l, i) => console.log(`  ${i}: ${l}`));
          
          // Add fasal_calendar interactive handling
          // Find: the line that checks for "fasal register" and add || interactive id check
          const fasalRegLine = gwCode.indexOf("'fasal register'");
          if (fasalRegLine !== -1) {
            // Find the if condition that contains this
            const lineStart = gwCode.lastIndexOf('\n', fasalRegLine) + 1;
            const lineEnd = gwCode.indexOf('\n', fasalRegLine);
            const theLine = gwCode.substring(lineStart, lineEnd);
            console.log('\nTarget line:', theLine.trim());
            
            // Add || listReplyId === 'fasal_calendar' to the condition
            // But we need to know how interactive messages arrive - they come as msgBody = list_reply.id
            // In WhatsApp, when user selects a list item, the message type is 'interactive' and we extract the ID
            // Let's check how the code extracts interactive IDs
            const extractIdx = gwCode.indexOf('list_reply');
            if (extractIdx !== -1) {
              const extractCtx = gwCode.substring(extractIdx - 100, extractIdx + 200);
              console.log('\nInteractive extraction context:', extractCtx.substring(0, 300));
            }
            
            // The simplest approach: add 'fasal_calendar' to the condition
            // Find the includes/match for crop calendar triggers
            const triggerLine = gwCode.indexOf("'meri fasal'");
            if (triggerLine !== -1) {
              // Find the full condition
              const condStart = gwCode.lastIndexOf('if (', triggerLine);
              const condEnd = gwCode.indexOf(') {', triggerLine);
              const fullCond = gwCode.substring(condStart, condEnd + 3);
              console.log('\nFull condition:', fullCond);
              
              // Add fasal_calendar check
              const newCond = fullCond.replace(') {', " || cropMsg === 'fasal_calendar') {");
              if (newCond !== fullCond) {
                gwCode = gwCode.replace(fullCond, newCond);
                console.log('Added fasal_calendar to crop calendar trigger condition');
              }
            } else {
              // Try alternate approach - look for the array of trigger words
              const triggerArr = gwCode.indexOf("['fasal register'");
              if (triggerArr !== -1) {
                const arrEnd = gwCode.indexOf(']', triggerArr);
                const oldArr = gwCode.substring(triggerArr, arrEnd + 1);
                const newArr = oldArr.replace(']', ", 'fasal_calendar']");
                gwCode = gwCode.replace(oldArr, newArr);
                console.log('Added fasal_calendar to trigger array');
              } else {
                // Just add a simple check before the existing crop calendar block
                const cropMsgCheck = gwCode.indexOf("cropMsg === 'fasal register'") !== -1 ? 
                  gwCode.indexOf("cropMsg === 'fasal register'") :
                  gwCode.indexOf("=== 'fasal register'");
                  
                if (cropMsgCheck !== -1) {
                  // Add || to the condition
                  gwCode = gwCode.replace("=== 'fasal register'", "=== 'fasal register' || cropMsg === 'fasal_calendar'");
                  console.log('Added fasal_calendar check alongside fasal register');
                } else {
                  console.log('WARNING: Could not add fasal_calendar trigger - needs manual fix');
                }
              }
            }
          }
        }
      }
    }
  }
  
  fs.writeFileSync(gwPath, gwCode);
  console.log('Updated gateway.js. Size:', (Buffer.byteLength(gwCode) / 1024).toFixed(1), 'KB');
}

console.log('\nDONE! Commit and push to deploy.');
