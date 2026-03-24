-- 007_orders.sql
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number VARCHAR(20) UNIQUE NOT NULL,
    farmer_id UUID NOT NULL REFERENCES farmers(id),
    dealer_id UUID NOT NULL REFERENCES dealers(id),
    status order_status_enum DEFAULT 'pending',
    items JSONB NOT NULL,
    total_amount DECIMAL(10,2),
    payment_method VARCHAR(20),
    payment_status payment_status_enum DEFAULT 'pending',
    payment_reference VARCHAR(100),
    delivery_address TEXT,
    recommendation_context TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TRIGGER set_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
INSERT INTO _migrations (filename) VALUES ('007_orders.sql') ON CONFLICT DO NOTHING;
