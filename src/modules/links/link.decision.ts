import type { LinkStatus, LinkVerdict } from "./link.model.js";

/** What a click on a short link should do. See STATE-MACHINES.md section 8 for the table this implements. */
export type ClickDecision =
  | { kind: "notfound" }
  | { kind: "gone" }
  | { kind: "blocked" }
  | { kind: "warn"; reason: "suspicious" | "unchecked" | "lookalike" | "recheck_failed" }
  | { kind: "redirect" };

export interface ClickFacts {
  /** False when no link has this code. */
  exists: boolean;
  status: LinkStatus;
  verdict: LinkVerdict;
  domainBlocked: boolean;
  lookalike: boolean;
  /** The last check is older than the re-check window and a fresh check could not be completed in time. */
  recheckFailed: boolean;
}

/**
 * First matching rule wins (FR-LNK-16 to 19, D-12). `confirmed` is true when the person pressed Continue on the
 * warning page: that overrides warnings, never blocks, and never reaches a gone or unknown link.
 */
export function decideClick(f: ClickFacts, confirmed = false): ClickDecision {
  if (!f.exists) return { kind: "notfound" };
  if (f.status === "inactive") return { kind: "gone" };
  if (f.status === "blocked" || f.verdict === "malicious" || f.domainBlocked) return { kind: "blocked" };
  if (confirmed) return { kind: "redirect" };
  if (f.recheckFailed) return { kind: "warn", reason: "recheck_failed" };
  if (f.verdict === "suspicious") return { kind: "warn", reason: "suspicious" };
  if (f.verdict === "unchecked") return { kind: "warn", reason: "unchecked" };
  if (f.lookalike) return { kind: "warn", reason: "lookalike" };
  return { kind: "redirect" };
}
