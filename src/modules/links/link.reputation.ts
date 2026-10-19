import { isIP } from "node:net";
import { logger } from "../../core/utils/logger.js";
import type { LinkVerdict } from "./link.model.js";

/**
 * Reputation sources are replaceable (IR-SW-6, D-13). A provider answers for one URL; the service combines them.
 * To add a feed or Google Web Risk, write a class implementing this and add it in `links.module.ts`.
 */
export interface ReputationResult {
  verdict: LinkVerdict;
  source: string;
}

export interface LinkReputationProvider {
  readonly name: string;
  /** May throw when the source is unavailable; the chain then reports `unchecked`, never `clean`. */
  check(url: string, host: string): Promise<ReputationResult>;
}

/** Top-level domains with a very high share of abuse (free registrations, or lookalikes for file types). */
const RISKY_TLDS = new Set([
  "zip",
  "mov",
  "tk",
  "ml",
  "ga",
  "cf",
  "gq",
  "xyz",
  "top",
  "click",
  "country",
  "kim",
  "work",
]);
const BAIT_WORDS = /(login|signin|verify|account|secure|update|wallet|password|bank)/i;

/**
 * Local red-flag checks that need no network: a bare IP address, punycode (internationalised) hosts, a risky TLD, an
 * unusually deep host, or credential-bait wording combined with an unfamiliar host. It can raise suspicion but cannot
 * prove a site is safe, so real feeds belong next to it in the chain.
 */
export class HeuristicReputationProvider implements LinkReputationProvider {
  readonly name = "heuristic";

  async check(url: string, host: string): Promise<ReputationResult> {
    const labels = host.split(".");
    const tld = labels.at(-1) ?? "";
    const flags = [
      isIP(host) !== 0,
      labels.some((l) => l.startsWith("xn--")),
      RISKY_TLDS.has(tld),
      labels.length > 5,
      BAIT_WORDS.test(host) && labels.length > 2,
    ];
    return { verdict: flags.some(Boolean) ? "suspicious" : "clean", source: this.name };
  }
}

/** Runs every provider and keeps the worst answer. A provider that fails turns an otherwise clean result `unchecked`. */
export class ReputationChain {
  constructor(private readonly providers: LinkReputationProvider[]) {}

  async check(url: string, host: string): Promise<ReputationResult> {
    const settled = await Promise.allSettled(this.providers.map((p) => p.check(url, host)));
    const results: ReputationResult[] = [];
    let failed = false;
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") results.push(r.value);
      else {
        failed = true;
        logger.warn({ provider: this.providers[i].name, err: (r.reason as Error)?.message }, "reputation check failed");
      }
    });

    const worst = (v: LinkVerdict) => results.find((r) => r.verdict === v);
    const hit = worst("malicious") ?? worst("suspicious");
    if (hit) return hit;
    if (failed || results.length === 0) return { verdict: "unchecked", source: "unavailable" };
    return { verdict: "clean", source: results.map((r) => r.source).join("+") };
  }
}
