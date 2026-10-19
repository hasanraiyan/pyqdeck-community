import { createApp } from "./app.js";
import { getServices } from "./composition.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import { logger } from "./core/utils/logger.js";
import { getCommunityService } from "./modules/communities/community.module.js";
import { createMediaCleanupJob } from "./modules/media/media.module.js";

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

async function main() {
  await connectDatabase();
  await getCommunityService().ensureDefaults(env.SEED_COMMUNITIES);

  const cleanupJob = createMediaCleanupJob();
  cleanupJob.start();

  // Soft-deleted posts are removed for good after the 30-day window (D-9). Harmless if several instances run it.
  const purgeTimer = setInterval(() => {
    getServices()
      .posts.purgeExpired()
      .then((n) => n > 0 && logger.info({ purged: n }, "purged expired posts"))
      .catch((err) => logger.error({ err }, "post purge failed"));
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  const server = createApp().listen(env.PORT, () => {
    logger.info(`Server running on http://localhost:${env.PORT} (docs: /api/docs, mode: ${env.SERVE_MODE})`);
  });

  const shutdown = () => {
    cleanupJob.stop();
    clearInterval(purgeTimer);
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
