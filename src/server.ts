import { createApp } from "./app.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import { logger } from "./core/utils/logger.js";

async function main() {
  await connectDatabase();
  const server = createApp().listen(env.PORT, () => {
    logger.info(`Server running on http://localhost:${env.PORT} (docs: /api/docs)`);
  });

  const shutdown = () => {
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal(err);
  process.exit(1);
});
