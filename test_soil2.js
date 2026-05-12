const https = require('https');

// Check farmer profile
https.get('https://vartmap.onrender.com/api/v1/crop-calendar/debug', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('Debug:', d);
    
    // Test with the rice registration ID
    https.get('https://vartmap.onrender.com/api/v1/crop-calendar/nutrition-schedule/0789ea43-d559-49f4-a58d-0df0b5dd101a', (res2) => {
      let d2 = '';
      res2.on('data', c => d2 += c);
      res2.on('end', () => {
        try {
          const data = JSON.parse(d2);
          console.log('\n=== Nutrition Schedule Response ===');
          console.log('Farmer:', JSON.stringify(data.farmer));
          console.log('Soil:', JSON.stringify(data.soil_data));
          console.log('District offset:', data.district_offset_days);
          console.log('Registration:', JSON.stringify(data.registration));
        } catch(e) {
          console.log('Response:', d2.substring(0, 500));
        }
      });
    });
  });
});
