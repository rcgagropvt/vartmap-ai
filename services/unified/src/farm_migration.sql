-- Farmer Farms table for crop monitoring
CREATE TABLE IF NOT EXISTS farmer_farms (
  id SERIAL PRIMARY KEY,
  farmer_id INTEGER NOT NULL,
  name VARCHAR(100) DEFAULT 'My Farm',
  coordinates JSONB NOT NULL,
  agro_polygon_id VARCHAR(100),
  crop VARCHAR(50),
  area_acres DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farmer_farms_farmer ON farmer_farms(farmer_id);
