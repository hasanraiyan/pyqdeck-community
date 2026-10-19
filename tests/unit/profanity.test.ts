import { describe, expect, it, vi } from "vitest";
import { ModerationPolicy } from "../../src/modules/moderation/moderation.policy.js";
import { ModerationService, PROFANITY_PROVIDER } from "../../src/modules/moderation/moderation.service.js";
import type { ModerationAudit, ModerationProvider } from "../../src/modules/moderation/moderation.types.js";
import { NoProfanityFilter, ProfanityFilter, profanityVariants } from "../../src/modules/moderation/profanity.js";

const filter = new ProfanityFilter();

describe("ProfanityFilter", () => {
  it.each(["you are a fucking idiot", "Fuck this", "what the FUCK", "total bullshit", "shut up bitch", "asshole"])(
    "blocks %j",
    (text) => expect(filter.contains(text)).toBe(true),
  );

  it("catches the usual tricks: look-alike symbols, stretched letters, spacing and hidden characters", () => {
    for (const text of [
      "sh1t",
      "f@ck you",
      "a$$hole",
      "fuuuuuck",
      "f u c k",
      "fu" + String.fromCharCode(0x200b) + "ck",
      "FUCK!!!",
      "(fuck)",
    ]) {
      expect(filter.contains(text), text).toBe(true);
    }
  });

  it("blocks abuse in Hindi written in English letters", () => {
    for (const text of ["tu madarchod hai", "bhosdike", "BSDK", "kya chutiya hai"]) {
      expect(filter.contains(text), text).toBe(true);
    }
  });

  it("matches whole words only, so ordinary words are not caught", () => {
    for (const text of [
      "class assignment",
      "assess the assembly",
      "Scunthorpe and Penistone",
      "analysis of algorithms",
      "hello world",
      "cocktail party",
      "Dijkstra's shortest path",
      "the passage of the bill",
      "grass is green",
      "10 5 3 marks question",
    ]) {
      expect(filter.contains(text), text).toBe(false);
    }
  });

  it("lets everyday and subject words through by default (biology, civil engineering, mild words)", () => {
    for (const text of [
      "sex ratio of the population",
      "anus and rectum anatomy",
      "dyke breach analysis",
      "oh damn",
      "what the hell",
    ]) {
      expect(filter.contains(text), text).toBe(false);
    }
  });

  it("ignores links, because the link service judges those and a domain name is not speech", () => {
    expect(filter.contains("read https://example.com/fuck-this-bug and www.shitposts.org/x")).toBe(false);
    expect(filter.contains("see https://example.com but you are a fuck")).toBe(true);
  });

  it("lets the owner add words and allow others", () => {
    const custom = new ProfanityFilter({ extraWords: ["Noob"], allowedWords: ["fuck"] });
    expect(custom.contains("what a noob")).toBe(true);
    expect(custom.contains("fuck")).toBe(false);
    expect(custom.contains("shit")).toBe(true);
  });

  it("handles empty and very long text", () => {
    expect(filter.contains("")).toBe(false);
    expect(filter.contains("word ".repeat(5000))).toBe(false);
  });

  it("shows the forms it matches", () => {
    expect(profanityVariants("sh1t https://x.y/z")).toEqual(expect.arrayContaining(["sh1t  ", "shit  "]));
  });

  it("can be switched off", () => {
    expect(new NoProfanityFilter().contains("fuck")).toBe(false);
  });
});

describe("ModerationService with the word filter", () => {
  const clean = { flagged: false, categories: {}, scores: {} };
  const setup = () => {
    const provider: ModerationProvider = { name: "fake-ai", moderate: vi.fn(async () => clean) };
    const audit: ModerationAudit = { record: vi.fn(async () => undefined) };
    const service = new ModerationService(provider, new ModerationPolicy(), audit, filter);
    return { provider, audit, service };
  };

  it("refuses bad language without calling the provider, even when images come with it", async () => {
    const { provider, service } = setup();
    const decision = await service.moderate(
      { text: "you fucking idiot", images: [{ url: "https://img.test/a.png" }] },
      { source: "post", userId: "507f1f77bcf86cd799439011" },
    );
    expect(decision).toMatchObject({ action: "reject", categories: ["profanity"], degraded: false, escalate: false });
    expect(provider.moderate).not.toHaveBeenCalled();
  });

  it("records who and why, never the words", async () => {
    const { audit, service } = setup();
    await service.moderate({ text: "you fucking idiot" }, { source: "comment", userId: "507f1f77bcf86cd799439011" });
    expect(audit.record).toHaveBeenCalledTimes(1);
    const event = vi.mocked(audit.record).mock.calls[0][0];
    expect(event).toMatchObject({
      action: "reject",
      provider: PROFANITY_PROVIDER,
      categories: ["profanity"],
      source: "comment",
    });
    expect(JSON.stringify(event)).not.toMatch(/fuck|idiot/i);
  });

  it("still sends clean text to the provider", async () => {
    const { provider, service } = setup();
    const decision = await service.moderate({ text: "explain Dijkstra please" }, { source: "post" });
    expect(decision.action).toBe("allow");
    expect(provider.moderate).toHaveBeenCalledTimes(1);
  });

  it("does not touch image-only submissions", async () => {
    const { provider, service } = setup();
    await service.moderate({ images: [{ url: "https://img.test/a.png" }] }, { source: "media" });
    expect(provider.moderate).toHaveBeenCalledTimes(1);
  });

  it("works without a filter, exactly as before", async () => {
    const provider: ModerationProvider = { name: "fake-ai", moderate: vi.fn(async () => clean) };
    const service = new ModerationService(provider, new ModerationPolicy());
    expect((await service.moderate({ text: "fuck" }, { source: "post" })).action).toBe("allow");
  });
});
