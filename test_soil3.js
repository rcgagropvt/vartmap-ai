const https = require('https');

https.get('https://vartmap.onrender.com/api/v1/crop-calendar/nutrition-schedule/0789ea43-d559-49f4-a58d-0df0b5dd101a', (res) => {
  let d = '';
  console.log('Status:', res.statusCode);
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('Full response:', d);
  });
}).on('error', e => console.log('Error:', e.message));
