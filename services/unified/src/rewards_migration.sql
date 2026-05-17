
-- Rewards & Gamification Tables
CREATE TABLE IF NOT EXISTS farmer_points (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  farmer_id UUID REFERENCES farmers(id) ON DELETE CASCADE UNIQUE,
  total_points INTEGER DEFAULT 0,
  current_level INTEGER DEFAULT 1,
  level_name VARCHAR(50) DEFAULT 'Beej',
  streak_days INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  last_active_date DATE,
  referral_code VARCHAR(20) UNIQUE,
  total_referrals INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS point_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  farmer_id UUID REFERENCES farmers(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  points INTEGER NOT NULL,
  description VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_id UUID REFERENCES farmers(id) ON DELETE CASCADE,
  referred_phone VARCHAR(15),
  referred_id UUID REFERENCES farmers(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'pending',
  points_awarded BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_farmer_points_farmer ON farmer_points(farmer_id);
CREATE INDEX IF NOT EXISTS idx_farmer_points_total ON farmer_points(total_points DESC);
CREATE INDEX IF NOT EXISTS idx_point_transactions_farmer ON point_transactions(farmer_id);
CREATE INDEX IF NOT EXISTS idx_point_transactions_type ON point_transactions(type);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON farmer_points(referral_code);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
