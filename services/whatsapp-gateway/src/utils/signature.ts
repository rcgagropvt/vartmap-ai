import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Verify X-Hub-Signature-256 from Meta webhook payloads.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac("sha256", config.WA_APP_SECRET)
    .update(rawBody)
    .digest("hex");

  const received = signatureHeader.replace("sha256=", "");

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(received, "hex")
  );
}
