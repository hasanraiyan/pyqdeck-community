import { logger } from "../../core/utils/logger.js";
import type { ModerationPolicy } from "./moderation.policy.js";
import {
  ModerationInputError,
  ModerationUnavailableError,
  type ModerationAudit,
  type ModerationContext,
  type ModerationDecision,
  type ModerationInput,
  type ModerationProvider,
  type ProviderVerdict,
} from "./moderation.types.js";

/** Bounds cost and latency: nobody needs 100k characters of a post checked, and the tail of a huge text is not scanned. */
export const MAX_MODERATED_TEXT_CHARS = 10_000;

const NOTHING_TO_CHECK: ModerationDecision = {
  action: "allow",
  categories: [],
  reasons: [],
  degraded: false,
  escalate: false,
};

/**
 * The one entry point for moderating content. Features call `moderate()` and act on `decision.action`:
 *   allow   -> publish
 *   review  -> do not publish (hold for a moderator, or reject if there is no review queue yet)
 *   reject  -> do not publish
 * It never throws because the provider is down: that yields `review` with `degraded: true`, so nothing unchecked is
 * ever published.
 */
export class ModerationService {
  constructor(
    private readonly provider: ModerationProvider,
    private readonly policy: ModerationPolicy,
    private readonly audit?: ModerationAudit,
  ) {}

  async moderate(input: ModerationInput, context: ModerationContext): Promise<ModerationDecision> {
    const text = input.text?.trim().slice(0, MAX_MODERATED_TEXT_CHARS);
    const images = input.images ?? [];
    if (!text && images.length === 0) return NOTHING_TO_CHECK;

    let verdict: ProviderVerdict;
    try {
      verdict = await this.provider.moderate({ text, images });
    } catch (err) {
      return this.failed(err, context);
    }

    const decided = this.policy.decide(verdict);
    const decision: ModerationDecision = { ...decided, degraded: false };

    if (decision.action !== "allow") {
      if (decision.escalate)
        logger.error({ ...context }, "content flagged for child safety: escalate per your reporting process");
      await this.record(context, decision, verdict.scores);
    }
    return decision;
  }

  /** Both "provider is down" and "provider cannot read this" must fail closed, but they mean different things. */
  private async failed(err: unknown, context: ModerationContext): Promise<ModerationDecision> {
    const unreadable = err instanceof ModerationInputError;
    if (!unreadable && !(err instanceof ModerationUnavailableError)) {
      logger.error({ err }, "unexpected moderation error");
    } else {
      logger.warn({ err: (err as Error).message, source: context.source }, "moderation could not produce a verdict");
    }

    const decision: ModerationDecision = unreadable
      ? { action: "reject", categories: [], reasons: ["unprocessable_input"], degraded: false, escalate: false }
      : { action: "review", categories: [], reasons: ["moderation_unavailable"], degraded: true, escalate: false };
    // Outages are not the user's doing, so only unreadable content is put on their record.
    if (unreadable) await this.record(context, decision, {});
    return decision;
  }

  private async record(context: ModerationContext, decision: ModerationDecision, scores: Record<string, number>) {
    if (!this.audit) return;
    try {
      await this.audit.record({
        ...context,
        action: decision.action,
        degraded: decision.degraded,
        escalate: decision.escalate,
        categories: decision.categories,
        scores,
        provider: this.provider.name,
      });
    } catch (err) {
      // The audit trail is important but must never break moderation itself.
      logger.error({ err }, "failed to record moderation event");
    }
  }
}
