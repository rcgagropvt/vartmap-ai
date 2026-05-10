-- Videos table for farmer app video section
CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
  video_id VARCHAR(20) NOT NULL,
  title VARCHAR(255) NOT NULL,
  duration VARCHAR(10) NOT NULL DEFAULT '0:00',
  type VARCHAR(10) NOT NULL DEFAULT 'short' CHECK (type IN ('short', 'video')),
  category VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  order_num INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert first video
INSERT INTO videos (video_id, title, duration, type, order_num)
VALUES ('NcwAGns4K9M', 'Vartmaan Fertilizers - Micronutrient Guide', '0:15', 'short', 1)
ON CONFLICT DO NOTHING;

CREATE INDEX idx_videos_active ON videos (is_active, order_num);
