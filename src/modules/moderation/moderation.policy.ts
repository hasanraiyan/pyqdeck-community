import type { ModerationDecision, ProviderVerdict } from "./moderation.types.js";

/** What happens when the provider flags a category. */
export type Severity = "reject" | "review" | "ignore";

export interface PolicyConfig {
  categories: Record<string, Severity>;
  /**
   * A category that is NOT flagged but scores at least this high still goes to review, so content just under the
   * provider's cut-off is not waved through. Set to 1 to turn the safety margin off.
   */
  nearMissScore: number;
}

/**
 * Starting policy for a student community. Edit this to match the community guidelines; nothing else changes.
 * Categories the provider adds in future and that are missing here default to `review` (see `unknownSeverity`).
 */
export const DEFAULT_POLICY: PolicyConfig = {
  categories: {
    sexual: "reject",
    "sexual/minors": "reject",
    hate: "reject",
    "hate/threatening": "reject",
    "harassment/threatening": "reject",
    "violence/graphic": "reject",
    "self-harm/instructions": "reject",
    "illicit/violent": "reject",
    harassment: "review",
    violence: "review",
    illicit: "review",
    "self-harm": "review",
    "self-harm/intent": "review",
  },
  nearMissScore: 0.5,
};

const ESCALATE_CATEGORIES = ["sexual/minors"];

/** Turns a provider verdict into an action. Pure and synchronous, so it is trivial to test and tune. */
export class ModerationPolicy {
  constructor(
    private readonly config: PolicyConfig = DEFAULT_POLICY,
    private readonly unknownSeverity: Severity = "review",
  ) {}

  decide(verdict: ProviderVerdict): Omit<ModerationDecision, "degraded"> {
    const rejected: string[] = [];
    const reviewed: string[] = [];
    const reasons: string[] = [];

    for (const [category, flagged] of Object.entries(verdict.categories)) {
      if (!flagged) continue;
      const severity = this.config.categories[category] ?? this.unknownSeverity;
      if (severity === "reject") rejected.push(category);
      else if (severity === "review") reviewed.push(category);
      reasons.push(`flagged:${category}`);
    }

    // The provider may not have flagged it, but a high score in a category we care about is worth a human look.
    const nearMisses: string[] = [];
    for (const [category, score] of Object.entries(verdict.scores)) {
      const severity = this.config.categories[category] ?? this.unknownSeverity;
      if (severity === "ignore" || verdict.categories[category] || score < this.config.nearMissScore) continue;
      nearMisses.push(category);
      reasons.push(`near_miss:${category}`);
    }

    const escalate = ESCALATE_CATEGORIES.some((c) => verdict.categories[c]);
    if (rejected.length > 0) return { action: "reject", categories: rejected, reasons, escalate };
    if (reviewed.length > 0 || nearMisses.length > 0) {
      return { action: "review", categories: [...reviewed, ...nearMisses], reasons, escalate };
    }
    return { action: "allow", categories: [], reasons: [], escalate: false };
  }
}
