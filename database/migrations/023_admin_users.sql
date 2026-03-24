-- 023_admin_users.sql
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    role admin_role_enum NOT NULL,
    phone VARCHAR(15),
    is_active BOOLEAN DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TRIGGER set_admin_updated_at BEFORE UPDATE ON admin_users FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
INSERT INTO _migrations (filename) VALUES ('023_admin_users.sql') ON CONFLICT DO NOTHING;
