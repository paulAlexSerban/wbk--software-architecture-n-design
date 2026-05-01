const pino = require("pino");
const fs = require("node:fs");
const path = require("node:path");

const defaultLevel = process.env.NODE_ENV === "test" ? "silent" : "info";

const baseOptions = {
  level: process.env.LOG_LEVEL || defaultLevel,
  base: {
    service: "leaderboard-ssr-service",
  },
};

const logFile = process.env.LOG_FILE;
let logger;

if (logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fileStream = pino.destination({
    dest: logFile,
    sync: false,
  });
  logger = pino(baseOptions, fileStream);
} else {
  logger = pino(baseOptions);
}

module.exports = logger;