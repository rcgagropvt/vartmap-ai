const fs = require('fs');
const path = require('path');

// Test the soil data lookup directly
const https = require('https');

// First check what district the farmer has
https.get('https://vartmap.onrender.com/api/v1/crop-calendar/debug', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('Debug:', d);
    
    // Now test nutrition schedule to see what district it resolves
    https.get('https://vartmap.onrender.com/api/v1/crop-calendar/nutrition-schedule/5ceb4eb6-dfc4-4e5d-a98e-168ce8907786', (res2) => {
      let d2 = '';
      res2.on('data', c => d2 += c);
      res2.on('end', () => {
        const data = JSON.parse(d2);
        console.log('\nFarmer district:', data.farmer?.district);
        console.log('Soil data:', data.soil_data);
        console.log('District offset:', data.district_offset_days);
      });
    });
  });
});
