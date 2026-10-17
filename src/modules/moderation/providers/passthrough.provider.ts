import { logger } from "../../../core/utils/logger.js";
import type { ModerationProvider, ProviderVerdict } from "../moderation.types.js";

/**
 * Approves everything. Used ONLY in development when no moderation key is configured, so the app still runs
 * locally. Production refuses to start without a real key, so this can never silently disable moderation there.
 */
export class PassthroughProvider implements ModerationProvider {
  readonly name = "disabled";
  private warned = false;

  async moderate(): Promise<ProviderVerdict> {
    if (!this.warned) {
      this.warned = true;
      logger.warn("OPENAI_API_KEY is not set: content moderation is DISABLED and everything is allowed");
    }
    return { flagged: false, categories: {}, scores: {} };
  }
}
