import { FastifyInstance } from "fastify";
import { db } from "../utils/db.js";
import axios from "axios";
import { config } from "../config.js";

export async function campaignRoutes(app: FastifyInstance) {
  app.addHook("preHandler", (app as any).authenticate);

  // Create campaign
  app.post("/", async (req) => {
    const body = req.body as any;
    const user = (req as any).user;

    const result = await db.query(
      `INSERT INTO campaigns (name, template_name, template_language, target_filter,
                              scheduled_at, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')
       RETURNING *`,
      [body.name, body.template_name, body.template_language || "hi",
       JSON.stringify(body.target_filter || {}), body.scheduled_at || null, user.id]
    );
    return result.rows[0];
  });

  // List campaigns
  app.get("/", async (req) => {
    const { page = 1, limit = 20 } = req.query as any;
    const rows = await db.query(
      "SELECT * FROM campaigns ORDER BY created_at DESC LIMIT $1 OFFSET $2",
      [limit, (page - 1) * limit]
    );
    return { campaigns: rows.rows };
  });

  // Launch campaign
  app.post("/:id/launch", async (req) => {
    const { id } = req.params as { id: string };
    const user = (req as any).user;

    // Get campaign
    const campaign = await db.query("SELECT * FROM campaigns WHERE id = $1", [id]);
    if (!campaign.rows[0]) return { error: "Campaign not found" };

    const c = campaign.rows[0];
    const filter = c.target_filter || {};

    // Build target audience query
    let where = "WHERE onboarding_complete = TRUE AND consent_given = TRUE";
    const params: any[] = [];
    let idx = 1;

    if (filter.state) { where += ` AND state_code = $${idx}`; params.push(filter.state); idx++; }
    if (filter.district) { where += ` AND LOWER(district) = LOWER($${idx})`; params.push(filter.district); idx++; }
    if (filter.crops?.length) { where += ` AND crops && $${idx}`; params.push(filter.crops); idx++; }
    if (filter.tier) { where += ` AND tier = $${idx}`; params.push(filter.tier); idx++; }

    const farmers = await db.query(`SELECT id, phone, bsuid, preferred_language FROM farmers ${where}`, params);

    // Update campaign status
    await db.query(
      "UPDATE campaigns SET status = 'sending', target_count = $1, launched_at = NOW(), launched_by = $2 WHERE id = $3",
      [farmers.rows.length, user.id, id]
    );

    // Send messages in batches via WhatsApp Gateway
    const batchSize = 50;
    let sent = 0;
    for (let i = 0; i < farmers.rows.length; i += batchSize) {
      const batch = farmers.rows.slice(i, i + batchSize);
      const messages = batch.map((f: any) => ({
        to: f.phone,
        type: "template",
        body: {
          name: c.template_name,
          language: { code: f.preferred_language || c.template_language || "hi" },
          components: c.template_components || [],
        },
        bsuid: f.bsuid,
        farmer_id: f.id,
      }));

      try {
        await axios.post(`${config.WA_GATEWAY_URL}/api/v1/messages/send-batch`, { messages }, { timeout: 60000 });
        sent += batch.length;
      } catch (err: any) {
        console.error(`Campaign batch failed at offset ${i}:`, err.message);
      }

      // Pacing: wait 2 seconds between batches (respect Meta pacing)
      if (i + batchSize < farmers.rows.length) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    await db.query(
      "UPDATE campaigns SET status = 'completed', sent_count = $1, completed_at = NOW() WHERE id = $2",
      [sent, id]
    );

    return { campaign_id: id, target_count: farmers.rows.length, sent_count: sent, status: "completed" };
  });
}
