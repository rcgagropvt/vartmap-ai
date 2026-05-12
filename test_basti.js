const https = require('https');

// First, set the farmer's district to Basti using the district command endpoint
const data = JSON.stringify({});
const options = {
  hostname: 'vartmap.onrender.com',
  path: '/api/v1/crop-calendar/debug',
  method: 'GET'
};

// Check if farmer has district set - we need to update it directly
// Use a simple endpoint to update
const updateData = JSON.stringify({ district: 'basti' });

// Let's just query the soil data for Basti directly to verify it exists
https.get('https://vartmap.onrender.com/api/v1/soil?district=basti', (res) => {
  let d = '';
  console.log('Soil API status:', res.statusCode);
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('Soil response (first 500):', d.substring(0, 500));
  });
}).on('error', e => console.log('Error:', e.message));
