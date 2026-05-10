import { FastifyInstance } from "fastify";
import { db } from "../utils/db.js";

export async function videoRoutes(app: FastifyInstance) {
  // GET all videos (admin)
  app.get("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { rows } = await db.query("SELECT * FROM videos ORDER BY order_num ASC, created_at DESC");
    return rows;
  });

  // GET active videos (public - for farmer app)
  app.get("/public", async (req, reply) => {
    const { rows } = await db.query("SELECT * FROM videos WHERE is_active = true ORDER BY order_num ASC");
    return rows;
  });

  // POST add video
  app.post("/", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const { video_id, title, duration, type, category } = req.body;
    if (!video_id || !title) return reply.status(400).send({ error: "video_id and title are required" });

    const { rows } = await db.query(
      `INSERT INTO videos (video_id, title, duration, type, category, is_active, order_num)
       VALUES ($1, $2, $3, $4, $5, true, (SELECT COALESCE(MAX(order_num), 0) + 1 FROM videos))
       RETURNING *`,
      [video_id, title, duration || "0:00", type || "short", category || null]
    );
    return rows[0];
  });

  // PUT update video
  app.put("/:id", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const { id } = req.params;
    const { video_id, title, duration, type, category, is_active, order_num } = req.body;

    const { rows } = await db.query(
      `UPDATE videos SET
        video_id = COALESCE($1, video_id),
        title = COALESCE($2, title),
        duration = COALESCE($3, duration),
        type = COALESCE($4, type),
        category = COALESCE($5, category),
        is_active = COALESCE($6, is_active),
        order_num = COALESCE($7, order_num),
        updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [video_id, title, duration, type, category, is_active, order_num, id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: "Video not found" });
    return rows[0];
  });

  // DELETE video
  app.delete("/:id", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const { id } = req.params;
    await db.query("DELETE FROM videos WHERE id = $1", [id]);
    return { message: "Video deleted" };
  });

  // POST toggle active status
  app.post("/:id/toggle", { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const { id } = req.params;
    const { rows } = await db.query(
      "UPDATE videos SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING *",
      [id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: "Video not found" });
    return rows[0];
  });
}
