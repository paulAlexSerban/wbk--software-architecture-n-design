const express = require("express");
const logger = require("../logger");

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

router.get("/health/log-probe", (req, res) => {
  const source = req.query.source || "unknown";
  const vu = req.query.vu || "n/a";
  const iter = req.query.iter || "n/a";
  const probeId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  const context = { probeId, source, vu, iter };
  logger.debug(context, "Log probe: debug level emitted");
  logger.info(context, "Log probe: info level emitted");
  logger.warn(context, "Log probe: warn level emitted");
  logger.error(context, "Log probe: error level emitted");
  logger.fatal(context, "Log probe: fatal level emitted (simulated, no exit)");

  res.json({
    status: "ok",
    probeId,
    emitted: ["debug", "info", "warn", "error", "fatal"],
  });
});

module.exports = router;
