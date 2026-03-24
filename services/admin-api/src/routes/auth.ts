import { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { db } from "../utils/db.js";
import { config } from "../config.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/login", async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };

    const result = await db.query(
      "SELECT id, email, name, role, password_hash, permissions FROM admin_users WHERE email = $1 AND is_active = TRUE",
      [email]
    );
    const user = result.rows[0];
    if (!user) return reply.status(401).send({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return reply.status(401).send({ error: "Invalid credentials" });

    // Update last login
    await db.query("UPDATE admin_users SET last_login = NOW() WHERE id = $1", [user.id]);

    // Audit log
    await db.query(
      `SELECT fn_audit_insert($1,$2,$3,$4,$5,$6)`,
      ["admin.login", "admin", user.id, "admin", user.id, "login"]
    );

    const token = app.jwt.sign(
      { id: user.id, email: user.email, role: user.role, permissions: user.permissions },
      { expiresIn: config.JWT_EXPIRY }
    );

    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.get("/me", { preHandler: [(app as any).authenticate] }, async (req) => {
    const user = (req as any).user;
    return user;
  });
}
