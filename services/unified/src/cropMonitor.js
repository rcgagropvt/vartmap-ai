// Crop Monitoring Engine - Satellite NDVI + Field Mapping

const AGRO_API_KEY = process.env.AGRO_API_KEY || '';
const AGRO_BASE = 'https://api.agromonitoring.com/agro/1.0';

// Create polygon on Agromonitoring
async function createPolygon(name, coordinates) {
  const res = await fetch(AGRO_BASE + '/polygons?appid=' + AGRO_API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name,
      geo_json: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [coordinates] // [[lon,lat], [lon,lat], ...]
        }
      }
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Agro API create polygon failed: ' + err);
  }
  return await res.json();
}

// Delete polygon
async function deletePolygon(polyId) {
  const res = await fetch(AGRO_BASE + '/polygons/' + polyId + '?appid=' + AGRO_API_KEY, {
    method: 'DELETE'
  });
  return res.ok;
}

// Get satellite imagery list for polygon
async function getSatelliteImages(polyId, start, end) {
  const url = AGRO_BASE + '/image/search?start=' + start + '&end=' + end + '&polyid=' + polyId + '&appid=' + AGRO_API_KEY;
  const res = await fetch(url);
  if (!res.ok) return [];
  return await res.json();
}

// Get NDVI stats for polygon from image
async function getNDVIStats(polyId) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - (30 * 24 * 60 * 60); // last 30 days
  const images = await getSatelliteImages(polyId, start, end);
  if (!images || images.length === 0) return null;
  
  // Get the most recent image with NDVI data
  const latest = images[images.length - 1];
  
  // Fetch NDVI stats
  if (latest.stats && latest.stats.ndvi) {
    const statsRes = await fetch(latest.stats.ndvi + '&appid=' + AGRO_API_KEY);
    if (statsRes.ok) {
      const stats = await statsRes.json();
      return {
        date: new Date(latest.dt * 1000).toISOString().split('T')[0],
        ndvi: stats,
        imageUrl: latest.image ? latest.image.ndvi : null,
        trueColor: latest.image ? latest.image.truecolor : null,
        clouds: latest.cl || 0,
        dataAvailable: true
      };
    }
  }
  
  return {
    date: new Date(latest.dt * 1000).toISOString().split('T')[0],
    ndvi: { mean: latest.data ? latest.data[0].mean : null },
    imageUrl: latest.image ? latest.image.ndvi : null,
    trueColor: latest.image ? latest.image.truecolor : null,
    clouds: latest.cl || 0,
    dataAvailable: true
  };
}

// Get NDVI history for trend
async function getNDVIHistory(polyId, days) {
  days = days || 90;
  const end = Math.floor(Date.now() / 1000);
  const start = end - (days * 24 * 60 * 60);
  const images = await getSatelliteImages(polyId, start, end);
  if (!images || images.length === 0) return [];
  
  return images.map(img => ({
    date: new Date(img.dt * 1000).toISOString().split('T')[0],
    ndvi: img.data && img.data[0] ? img.data[0].mean : null,
    clouds: img.cl || 0
  })).filter(d => d.ndvi !== null);
}

// Get soil data
async function getSoilData(polyId) {
  const url = AGRO_BASE + '/soil?polyid=' + polyId + '&appid=' + AGRO_API_KEY;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    moisture: data.moisture || null,
    temperature: data.t0 ? (data.t0 - 273.15).toFixed(1) : null, // Kelvin to Celsius
    temperature10cm: data.t10 ? (data.t10 - 273.15).toFixed(1) : null
  };
}

// Get weather for polygon
async function getPolygonWeather(polyId) {
  const url = AGRO_BASE + '/weather?polyid=' + polyId + '&appid=' + AGRO_API_KEY;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    temp: data.main ? (data.main.temp - 273.15).toFixed(1) : null,
    humidity: data.main ? data.main.humidity : null,
    wind: data.wind ? data.wind.speed : null,
    description: data.weather && data.weather[0] ? data.weather[0].description : null,
    rain: data.rain ? data.rain['1h'] || 0 : 0
  };
}

// Calculate crop health score from NDVI
function getCropHealthScore(ndviMean) {
  if (ndviMean === null || ndviMean === undefined) return null;
  if (ndviMean >= 0.7) return { score: 95, status: 'Excellent', color: '#16A34A', hindi: 'उत्तम' };
  if (ndviMean >= 0.5) return { score: 75, status: 'Good', color: '#22C55E', hindi: 'अच्छा' };
  if (ndviMean >= 0.35) return { score: 55, status: 'Moderate', color: '#F59E0B', hindi: 'सामान्य' };
  if (ndviMean >= 0.2) return { score: 35, status: 'Stressed', color: '#EF4444', hindi: 'तनावग्रस्त' };
  return { score: 15, status: 'Critical', color: '#991B1B', hindi: 'गंभीर' };
}

// Generate irrigation advisory
function getIrrigationAdvisory(soilMoisture, weather, ndvi) {
  if (!soilMoisture && !weather) return { advisory: 'Data unavailable', hindi: 'डेटा उपलब्ध नहीं' };
  
  const moisture = soilMoisture ? soilMoisture.moisture : null;
  const temp = weather ? parseFloat(weather.temp) : null;
  const rain = weather ? weather.rain : 0;
  
  if (rain > 5) return { advisory: 'No irrigation needed - recent rainfall', hindi: 'सिंचाई की जरूरत नहीं - बारिश हुई', urgency: 'low' };
  if (moisture && moisture < 0.2) return { advisory: 'Irrigate immediately - soil is very dry', hindi: 'तुरंत सिंचाई करें - मिट्टी बहुत सूखी', urgency: 'high' };
  if (moisture && moisture < 0.35) return { advisory: 'Irrigate within 24 hours', hindi: '24 घंटे में सिंचाई करें', urgency: 'medium' };
  if (temp && temp > 38) return { advisory: 'Evening irrigation recommended - high temperature', hindi: 'शाम को सिंचाई करें - तापमान अधिक', urgency: 'medium' };
  return { advisory: 'Soil moisture adequate', hindi: 'मिट्टी में नमी पर्याप्त', urgency: 'low' };
}

module.exports = {
  createPolygon,
  deletePolygon,
  getSatelliteImages,
  getNDVIStats,
  getNDVIHistory,
  getSoilData,
  getPolygonWeather,
  getCropHealthScore,
  getIrrigationAdvisory
};
