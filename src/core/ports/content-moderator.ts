/**
 * What feature modules need from moderation. They depend on this small port, not on the moderation module; the
 * adapter lives in `moderation.module.ts` (see AGENTS.md).
 */
export interface TextModerationContext {
  communityId: string;
  memberId: string;
  /** e.g. "post", "comment", "profile". */
  source: string;
  sourceId?: string;
}

export interface TextVerdict {
  action: "allow" | "review" | "reject";
  /** The checker was unavailable: `action` is `review` and nothing was actually judged. */
  degraded: boolean;
  categories: string[];
}

/** What to tell the person when content is refused: bad language gets a plain, fixable message. */
export function refusalMessage(categories: string[], fallback: string): string {
  return categories.includes("profanity")
    ? "Your text contains language that is not allowed here. Please edit it and try again."
    : fallback;
}

export interface ContentModerator {
  moderateText(text: string, context: TextModerationContext): Promise<TextVerdict>;
}
