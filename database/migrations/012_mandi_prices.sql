-- 012_mandi_prices.sql (TimescaleDB Hypertable)
CREATE TABLE IF NOT EXISTS mandi_prices (
    time TIMESTAMPTZ NOT NULL,
    commodity VARCHAR(50) NOT NULL,
    variety VARCHAR(50),
    mandi VARCHAR(100) NOT NULL,
    district VARCHAR(100),
    state VARCHAR(50),
    min_price DECIMAL(10,2),
    max_price DECIMAL(10,2),
    modal_price DECIMAL(10,2),
    arrival_tonnes DECIMAL(10,2),
    source VARCHAR(20) DEFAULT 'agmarknet'
);
SELECT create_hypertable('mandi_prices', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_mandi_commodity_time ON mandi_prices (commodity, time DESC);
CREATE INDEX IF NOT EXISTS idx_mandi_district_time ON mandi_prices (district, time DESC);
INSERT INTO _migrations (filename) VALUES ('012_mandi_prices.sql') ON CONFLICT DO NOTHING;
