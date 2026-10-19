/**
 * Contracts for content moderation. Features depend on `ModerationService`; the service depends only on the
 * `ModerationProvider` and `ModerationAudit` interfaces, so the vendor and the storage can change independently.
 */

/** An image to check: either a public URL, or raw bytes (used before anything has been stored). */
export type ModerationImage = { url: string } | { data: Buffer; mimeType: string };

export interface ModerationInput {
  text?: string;
  images?: ModerationImage[];
}

/** Who and what is being moderated. Used for the audit trail only; never sent to the provider. */
export interface ModerationContext {
  /** The community the content belongs to; every event is recorded against one (FR-COM-14). */
  communityId?: string;
  /** The member (not the account) who submitted it. */
  userId?: string;
  /** The kind of content, e.g. "media", "post", "comment". */
  source: string;
  /** Id of the thing being moderated, when it exists yet. */
  sourceId?: string;
}

/** The provider's raw judgement, normalised. No policy has been applied yet. */
export interface ProviderVerdict {
  flagged: boolean;
  /** Category name -> flagged by the provider. */
  categories: Record<string, boolean>;
  /** Category name -> confidence score 0..1 (a model score, not a probability of violating our rules). */
  scores: Record<string, number>;
}

export interface ModerationProvider {
  readonly name: string;
  /** Throws `ModerationUnavailableError` for outages/rate limits and `ModerationInputError` for unreadable input. */
  moderate(input: ModerationInput): Promise<ProviderVerdict>;
}

/** Transient or configuration failure: we could not get a verdict. Callers must not publish unchecked content. */
export class ModerationUnavailableError extends Error {
  constructor(message = "Moderation is unavailable") {
    super(message);
    this.name = "ModerationUnavailableError";
  }
}

/** The provider cannot read this input (corrupt or unsupported image). Retrying will not help. */
export class ModerationInputError extends Error {
  constructor(message = "Moderation could not process the input") {
    super(message);
    this.name = "ModerationInputError";
  }
}

/**
 * allow:  publish.
 * review: do not publish; hold for a human (or reject if you have no review queue yet).
 * reject: do not publish.
 */
export type ModerationAction = "allow" | "review" | "reject";

export interface ModerationDecision {
  action: ModerationAction;
  /** Categories that drove the decision (empty when allowed). */
  categories: string[];
  /** Machine-readable explanation, e.g. "flagged:sexual", "near_miss:hate", "moderation_unavailable". */
  reasons: string[];
  /** True when no verdict could be obtained (outage). `action` is then "review", never "allow". */
  degraded: boolean;
  /** True for the most serious category (sexual content involving minors). Needs a child-safety process, not just a block. */
  escalate: boolean;
}

export interface ModerationEventInput {
  communityId?: string;
  userId?: string;
  source: string;
  sourceId?: string;
  action: ModerationAction;
  degraded: boolean;
  escalate: boolean;
  categories: string[];
  scores: Record<string, number>;
  provider: string;
}

/** Records moderation outcomes. The content itself is deliberately never stored. */
export interface ModerationAudit {
  record(event: ModerationEventInput): Promise<void>;
}
