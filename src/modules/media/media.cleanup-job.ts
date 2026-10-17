import { logger } from "../../core/utils/logger.js";
import type { MediaService } from "./media.service.js";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/** Periodically deletes abandoned uploads. Single-instance timer: if you run several servers it is harmlessly redundant. */
export class MediaCleanupJob {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly service: Pick<MediaService, "cleanupExpired">,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref(); // never keeps the process alive on its own
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Skips if the previous run is still going, so slow providers cannot pile up overlapping runs. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const removed = await this.service.cleanupExpired();
      if (removed > 0) logger.info({ removed }, "removed expired uploads");
      return removed;
    } catch (err) {
      logger.error({ err }, "media cleanup failed");
      return 0;
    } finally {
      this.running = false;
    }
  }
}
