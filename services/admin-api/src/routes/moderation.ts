import { FastifyInstance } from "fastify";
import { db } from "../utils/db.js";

export async function moderationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", (app as any).authenticate);

  // Get moderation queue
  app.get("/queue", async (req) => {
    const { status = "pending", page = 1, limit = 20 } = req.query as any;
    const offset = (page - 1) * limit;

    const rows = await db.query(
      `SELECT mq.*, f.name AS farmer_name, f.phone AS farmer_phone
       FROM moderation_queue mq
       JOIN farmers f ON mq.farmer_id = f.id
       WHERE mq.status = $1
       ORDER BY mq.priority ASC, mq.created_at ASC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );

    const count = await db.query(
      "SELECT COUNT(*) FROM moderation_queue WHERE status = $1", [status]
    );

    return { total: parseInt(count.rows[0].count), items: rows.rows };
  });

  // Take action on a queue item
  app.post("/queue/:id/action", async (req) => {
    const { id } = req.params as { id: string };
    const { action_type, reason, duration_hours, policy_reference } = req.body as any;
    const user = (req as any).user;

    // Calculate expiry
    let expires_at = null;
    if (duration_hours && (action_type === "mute_user" || action_type === "ban_user")) {
      expires_at = new Date(Date.now() + duration_hours * 3600_000).toISOString();
    }

    // Insert action (trigger auto-updates farmer_moderation_status)
    await db.query(
      `INSERT INTO moderation_actions
         (queue_id, admin_id, action_type, reason, policy_reference, duration_hours, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, user.id, action_type, reason, policy_reference, duration_hours, expires_at]
    );

    // Update queue item status
    const newStatus = ["approve", "auto_approve"].includes(action_type) ? "resolved" :
                      action_type === "escalate" ? "escalated" : "resolved";
    await db.query(
      "UPDATE moderation_queue SET status = $1, assigned_to = $2, resolved_at = NOW() WHERE id = $3",
      [newStatus, user.id, id]
    );

    // Audit
    await db.query(
      `SELECT fn_audit_insert($1,$2,$3,$4,$5,$6,$7)`,
      ["moderation.action", "moderation_queue", id, "admin", user.id, action_type,
       JSON.stringify({ reason, duration_hours, policy_reference })]
    );

    return { status: "ok", action_type, queue_id: id };
  });

  // Appeals
  app.get("/appeals", async (req) => {
    const { status = "submitted", page = 1, limit = 20 } = req.query as any;
    const rows = await db.query(
      `SELECT ma.*, f.name, f.phone
       FROM moderation_appeals ma
       JOIN farmers f ON ma.farmer_id = f.id
       WHERE ma.status = $1
       ORDER BY ma.created_at ASC
       LIMIT $2 OFFSET $3`,
      [status, limit, (page - 1) * limit]
    );
    return { appeals: rows.rows };
  });

  app.post("/appeals/:id/review", async (req) => {
    const { id } = req.params as { id: string };
    const { decision, review_notes } = req.body as any; // 'upheld' or 'overturned'
    const user = (req as any).user;

    await db.query(
      `UPDATE moderation_appeals SET status = $1, reviewed_by = $2, review_notes = $3, reviewed_at = NOW()
       WHERE id = $4`,
      [decision, user.id, review_notes, id]
    );

    if (decision === "overturned") {
      // Get the original action and restore the farmer
      const appeal = await db.query("SELECT queue_id, farmer_id, action_id FROM moderation_appeals WHERE id = $1", [id]);
      if (appeal.rows[0]) {
        await db.query(
          `INSERT INTO moderation_actions (queue_id, admin_id, action_type, reason)
           VALUES ($1, $2, 'restore', $3)`,
          [appeal.rows[0].queue_id, user.id, `Appeal ${id} overturned: ${review_notes}`]
        );
      }
    }

    return { status: "ok", decision };
  });
}
