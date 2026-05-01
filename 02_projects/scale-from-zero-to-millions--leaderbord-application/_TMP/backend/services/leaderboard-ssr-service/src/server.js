const logger = require("./logger");
const { startTelemetry, shutdownTelemetry } = require("./telemetry");

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  await startTelemetry();
  const app = require("./app");

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "Leaderboard SSR service listening");
  });

  const gracefulShutdown = async (signal) => {
    logger.info({ signal }, "Shutting down server");
    server.close(async () => {
      try {
        await shutdownTelemetry();
      } finally {
        process.exit(0);
      }
    });
  };

  process.on("SIGINT", () => {
    gracefulShutdown("SIGINT").catch((error) => {
      logger.error({ err: error }, "Error during SIGINT shutdown");
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    gracefulShutdown("SIGTERM").catch((error) => {
      logger.error({ err: error }, "Error during SIGTERM shutdown");
      process.exit(1);
    });
  });
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, "Failed to bootstrap application");
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  logger.error({ err: error }, "Unhandled promise rejection");
});

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception");
  process.exit(1);
});
