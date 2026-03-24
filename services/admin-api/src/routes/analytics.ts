import { FastifyInstance } from "fastify";
import { db } from "../utils/db.js";

export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", (app as any).authenticate);

  // Dashboard overview
  app.get("/dashboard", async () => {
    const [farmers, active, conversations, cost, topFeatures] = await Promise.all([
      db.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') AS new_7d FROM farmers"),
      db.query("SELECT COUNT(DISTINCT farmer_id) AS count FROM usage_tracking WHERE created_at >= CURRENT_DATE"),
      db.query("SELECT COUNT(*) AS total FROM conversations WHERE created_at >= CURRENT_DATE"),
      db.query("SELECT COALESCE(SUM(cost_inr), 0) AS total FROM usage_tracking WHERE created_at >= date_trunc('month', CURRENT_DATE)"),
      db.query("SELECT feature, COUNT(*) AS count FROM usage_tracking WHERE created_at >= CURRENT_DATE - INTERVAL '7 days' GROUP BY feature ORDER BY count DESC LIMIT 10"),
    ]);

    return {
      total_farmers: parseInt(farmers.rows[0].total),
      new_farmers_7d: parseInt(farmers.rows[0].new_7d),
      active_today: parseInt(active.rows[0].count),
      conversations_today: parseInt(conversations.rows[0].total),
      ai_cost_this_month: parseFloat(cost.rows[0].total),
      top_features_7d: topFeatures.rows,
    };
  });

  // Daily active users trend
  app.get("/dau", async (req) => {
    const { days = 30 } = req.query as any;
    const rows = await db.query(
      `SELECT date_trunc('day', created_at)::date AS day,
              COUNT(DISTINCT farmer_id) AS dau
       FROM usage_tracking
       WHERE created_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
       GROUP BY 1 ORDER BY 1`,
      [days]
    );
    return { dau: rows.rows };
  });

  // Geographic distribution
  app.get("/geo", async () => {
    const rows = await db.query(
      `SELECT state_code, district, COUNT(*) AS farmer_count
       FROM farmers
       WHERE state_code IS NOT NULL
       GROUP BY state_code, district
       ORDER BY farmer_count DESC
       LIMIT 100`
    );
    return { distribution: rows.rows };
  });

  // Retention cohorts
  app.get("/retention", async () => {
    const rows = await db.query(
      `WITH cohorts AS (
         SELECT id, date_trunc('week', created_at)::date AS cohort_week
         FROM farmers
         WHERE created_at >= CURRENT_DATE - INTERVAL '12 weeks'
       )
       SELECT c.cohort_week,
              COUNT(DISTINCT c.id) AS cohort_size,
              COUNT(DISTINCT CASE WHEN u.created_at >= c.cohort_week + INTERVAL '7 days'
                                   AND u.created_at < c.cohort_week + INTERVAL '14 days'
                                  THEN u.farmer_id END) AS week_1,
              COUNT(DISTINCT CASE WHEN u.created_at >= c.cohort_week + INTERVAL '14 days'
                                   AND u.created_at < c.cohort_week + INTERVAL '21 days'
                                  THEN u.farmer_id END) AS week_2,
              COUNT(DISTINCT CASE WHEN u.created_at >= c.cohort_week + INTERVAL '21 days'
                                   AND u.created_at < c.cohort_week + INTERVAL '28 days'
                                  THEN u.farmer_id END) AS week_3
       FROM cohorts c
       LEFT JOIN usage_tracking u ON c.id = u.farmer_id
       GROUP BY c.cohort_week
       ORDER BY c.cohort_week`
    );
    return { cohorts: rows.rows };
  });
}
