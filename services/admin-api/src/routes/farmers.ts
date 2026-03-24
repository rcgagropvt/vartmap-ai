import { FastifyInstance } from "fastify";
import { db } from "../utils/db.js";

export async function farmerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", (app as any).authenticate);

  // List farmers with pagination, search, filters
  app.get("/", async (req) => {
    const { page = 1, limit = 50, search, state, district, tier } = req.query as any;
    const offset = (page - 1) * limit;

    let where = "WHERE 1=1";
    const params: any[] = [];
    let idx = 1;

    if (search) {
      where += ` AND (name ILIKE $${idx} OR phone ILIKE $${idx} OR district ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    if (state) { where += ` AND state_code = $${idx}`; params.push(state); idx++; }
    if (district) { where += ` AND LOWER(district) = LOWER($${idx})`; params.push(district); idx++; }
    if (tier) { where += ` AND tier = $${idx}`; params.push(tier); idx++; }

    const countResult = await db.query(`SELECT COUNT(*) FROM farmers ${where}`, params);
    const total = parseInt(countResult.rows[0].count);

    const rows = await db.query(
      `SELECT id, name, phone, bsuid, state_code, district, village, crops,
              land_acres, tier, preferred_language, onboarding_complete, created_at
       FROM farmers ${where}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    return { total, page, limit, farmers: rows.rows };
  });

  // Get single farmer with full details
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    const farmer = await db.query(
      `SELECT f.*, fms.is_muted, fms.is_banned, fms.trust_score, fms.warning_count
       FROM farmers f
       LEFT JOIN farmer_moderation_status fms ON f.id = fms.farmer_id
       WHERE f.id = $1`,
      [id]
    );
    if (!farmer.rows[0]) return { error: "Not found" };

    const conversations = await db.query(
      "SELECT id, direction, message_type, delivery_status, created_at FROM conversations WHERE farmer_id = $1 ORDER BY created_at DESC LIMIT 20",
      [id]
    );

    const usage = await db.query(
      "SELECT feature, COUNT(*) AS count, SUM(cost_inr) AS total_cost FROM usage_tracking WHERE farmer_id = $1 AND created_at >= CURRENT_DATE - INTERVAL '30 days' GROUP BY feature",
      [id]
    );

    return {
      farmer: farmer.rows[0],
      recent_conversations: conversations.rows,
      usage_30d: usage.rows,
    };
  });

  // Export farmers CSV
  app.get("/export/csv", async (req, reply) => {
    const { state, district } = req.query as any;
    let where = "WHERE onboarding_complete = TRUE";
    const params: any[] = [];
    let idx = 1;

    if (state) { where += ` AND state_code = $${idx}`; params.push(state); idx++; }
    if (district) { where += ` AND LOWER(district) = LOWER($${idx})`; params.push(district); idx++; }

    const rows = await db.query(
      `SELECT name, phone, state_code, district, village, array_to_string(crops,',') AS crops,
              land_acres, tier, preferred_language, created_at
       FROM farmers ${where} ORDER BY created_at DESC`,
      params
    );

    let csv = "name,phone,state,district,village,crops,land_acres,tier,language,registered\n";
    for (const r of rows.rows) {
      csv += `"${r.name || ""}","${r.phone}","${r.state_code || ""}","${r.district || ""}","${r.village || ""}","${r.crops || ""}","${r.land_acres || ""}","${r.tier || ""}","${r.preferred_language}","${r.created_at}"\n`;
    }

    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", "attachment; filename=farmers_export.csv");
    return csv;
  });
}
