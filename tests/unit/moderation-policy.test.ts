import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, ModerationPolicy } from "../../src/modules/moderation/moderation.policy.js";
import type { ProviderVerdict } from "../../src/modules/moderation/moderation.types.js";

const verdict = (flagged: string[] = [], scores: Record<string, number> = {}): ProviderVerdict => ({
  flagged: flagged.length > 0,
  categories: Object.fromEntries(flagged.map((c) => [c, true])),
  scores,
});

const policy = new ModerationPolicy();

describe("ModerationPolicy defaults", () => {
  it("allows clean content", () => {
    expect(policy.decide(verdict([], { sexual: 0.01, hate: 0.02 }))).toEqual({
      action: "allow",
      categories: [],
      reasons: [],
      escalate: false,
    });
  });

  it.each([
    "sexual",
    "sexual/minors",
    "hate",
    "hate/threatening",
    "harassment/threatening",
    "violence/graphic",
    "self-harm/instructions",
    "illicit/violent",
  ])("rejects flagged %s", (category) => {
    const decision = policy.decide(verdict([category]));
    expect(decision.action).toBe("reject");
    expect(decision.categories).toEqual([category]);
    expect(decision.reasons).toContain(`flagged:${category}`);
  });

  it.each(["harassment", "violence", "illicit", "self-harm", "self-harm/intent"])(
    "sends flagged %s to review, not straight to rejection",
    (category) => {
      expect(policy.decide(verdict([category])).action).toBe("review");
    },
  );

  it("lets the strictest category win when several are flagged", () => {
    const decision = policy.decide(verdict(["harassment", "hate"]));
    expect(decision.action).toBe("reject");
    expect(decision.categories).toEqual(["hate"]);
  });

  it("covers every category the policy knows about", () => {
    expect(Object.keys(DEFAULT_POLICY.categories)).toHaveLength(13);
  });
});

describe("near misses", () => {
  it("reviews content just under the provider's own cut-off", () => {
    const decision = policy.decide(verdict([], { hate: 0.6 }));
    expect(decision.action).toBe("review");
    expect(decision.reasons).toEqual(["near_miss:hate"]);
  });

  it("treats the threshold as inclusive and anything below as fine", () => {
    expect(policy.decide(verdict([], { hate: 0.5 })).action).toBe("review");
    expect(policy.decide(verdict([], { hate: 0.49 })).action).toBe("allow");
  });

  it("does not double count a category the provider already flagged", () => {
    const decision = policy.decide(verdict(["hate"], { hate: 0.99 }));
    expect(decision.reasons).toEqual(["flagged:hate"]);
  });

  it("can be switched off", () => {
    const off = new ModerationPolicy({ ...DEFAULT_POLICY, nearMissScore: 1.01 });
    expect(off.decide(verdict([], { hate: 1 })).action).toBe("allow");
  });

  it("ignores categories the policy says to ignore", () => {
    const custom = new ModerationPolicy({ categories: { illicit: "ignore" }, nearMissScore: 0.5 });
    expect(custom.decide(verdict(["illicit"], { illicit: 0.99 })).action).toBe("allow");
  });
});

describe("unknown categories and escalation", () => {
  it("holds a flagged category the policy has never heard of, so new provider categories fail safe", () => {
    expect(policy.decide(verdict(["brand-new-category"])).action).toBe("review");
  });

  it("can be told to reject unknown categories instead", () => {
    expect(new ModerationPolicy(DEFAULT_POLICY, "reject").decide(verdict(["brand-new-category"])).action).toBe(
      "reject",
    );
  });

  it("marks sexual content involving minors for escalation, and nothing else", () => {
    expect(policy.decide(verdict(["sexual/minors", "sexual"])).escalate).toBe(true);
    expect(policy.decide(verdict(["sexual"])).escalate).toBe(false);
    expect(policy.decide(verdict(["hate"])).escalate).toBe(false);
  });

  it("is configurable: a stricter community can reject what the default only reviews", () => {
    const strict = new ModerationPolicy({
      ...DEFAULT_POLICY,
      categories: { ...DEFAULT_POLICY.categories, harassment: "reject" },
    });
    expect(strict.decide(verdict(["harassment"])).action).toBe("reject");
  });
});

describe("stricter margin for sexual content", () => {
  const policy = new ModerationPolicy();
  const verdict = (scores: Record<string, number>) => ({ flagged: false, categories: {}, scores });

  it("holds a borderline sexual score that the general 0.5 margin would wave through", () => {
    expect(policy.decide(verdict({ sexual: 0.3 })).action).toBe("review");
    expect(policy.decide(verdict({ sexual: 0.1 })).action).toBe("allow");
    expect(policy.decide(verdict({ violence: 0.3 })).action).toBe("allow");
  });

  it("holds even a faint sign of sexual content involving minors", () => {
    expect(policy.decide(verdict({ "sexual/minors": 0.06 })).action).toBe("review");
  });
});
