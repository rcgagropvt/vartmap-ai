import { logger } from "../utils/logger.js";
import { db } from "../utils/db.js";

interface WAStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title: string; message: string }>;
}

export async function processStatusUpdate(status: WAStatus): Promise<void> {
  try {
    // Update conversation record with delivery status
    await db.query(
      `UPDATE conversations
       SET delivery_status = $1,
           delivery_status_at = to_timestamp($2::BIGINT),
           error_details = $3,
           updated_at = NOW()
       WHERE wa_message_id = $4`,
      [
        status.status,
        status.timestamp,
        status.errors ? JSON.stringify(status.errors) : null,
        status.id,
      ]
    );

    if (status.status === "failed") {
      logger.warn({
        messageId: status.id,
        recipient: status.recipient_id,
        errors: status.errors,
      }, "Message delivery failed");

      // Track failed delivery for analytics
      await db.query(
        `INSERT INTO usage_tracking (feature, channel, response_status, error_code, created_at)
         VALUES ('outbound_delivery', 'whatsapp', 'error', $1, NOW())`,
        [status.errors?.[0]?.code?.toString() || "unknown"]
      ).catch(() => {});
    }

    if (status.status === "read") {
      // Update crop calendar reminders if applicable
      await db.query(
        `UPDATE crop_calendar_reminders SET read_at = NOW()
         WHERE message_id = $1 AND read_at IS NULL`,
        [status.id]
      ).catch(() => {});
    }
  } catch (err) {
    logger.error({ err, statusId: status.id }, "Failed to process status update");
  }
}
