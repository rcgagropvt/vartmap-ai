import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  serializers: {
    req(req) {
      return { method: req.method, url: req.url, remoteAddress: req.ip };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
  redact: ["req.headers.authorization", "req.headers['x-hub-signature-256']"],
});
