import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ModerationPolicy } from "../../src/modules/moderation/moderation.policy.js";
import { MAX_MODERATED_TEXT_CHARS, ModerationService } from "../../src/modules/moderation/moderation.service.js";
import {
  ModerationInputError,
  ModerationUnavailableError,
  type ModerationEventInput,
  type ModerationProvider,
  type ProviderVerdict,
} from "../../src/modules/moderation/moderation.types.js";

const clean: ProviderVerdict = { flagged: false, categories: {}, scores: { hate: 0.01 } };
const flagged = (category: string, score = 0.95): ProviderVerdict => ({
  flagged: true,
  categories: { [category]: true },
  scores: { [category]: score },
});

const context = { userId: "507f1f77bcf86cd799439011", source: "post", sourceId: "p1" };

let provider: { name: string; moderate: Mock<ModerationProvider["moderate"]> };
let recorded: ModerationEventInput[];
let audit: { record: Mock<(event: ModerationEventInput) => Promise<void>> };
let service: ModerationService;

beforeEach(() => {
  provider = { name: "fake", moderate: vi.fn<ModerationProvider["moderate"]>(async () => clean) };
  recorded = [];
  audit = {
    record: vi.fn<(event: ModerationEventInput) => Promise<void>>(async (e) => {
      recorded.push(e);
    }),
  };
  service = new ModerationService(provider, new ModerationPolicy(), audit);
});

describe("ModerationService.moderate", () => {
  it("allows clean content and still records the result", async () => {
    const decision = await service.moderate({ text: "how do I prepare for DBMS?" }, context);

    expect(decision).toMatchObject({ action: "allow", degraded: false, escalate: false, categories: [] });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "allow", source: context.source }));
  });

  it("does not call the provider when there is nothing to check", async () => {
    for (const input of [{}, { text: "" }, { text: "   \n " }, { images: [] }]) {
      expect((await service.moderate(input, context)).action).toBe("allow");
    }
    expect(provider.moderate).not.toHaveBeenCalled();
  });

  it("rejects flagged content and records who, what and why, but never the content", async () => {
    provider.moderate.mockResolvedValue(flagged("hate", 0.93));

    const decision = await service.moderate({ text: "some hateful text" }, context);

    expect(decision).toMatchObject({ action: "reject", categories: ["hate"], degraded: false });
    expect(recorded).toEqual([
      {
        ...context,
        action: "reject",
        degraded: false,
        escalate: false,
        categories: ["hate"],
        scores: { hate: 0.93 },
        provider: "fake",
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain("hateful text");
  });

  it("holds borderline content for review", async () => {
    provider.moderate.mockResolvedValue(flagged("harassment"));
    expect((await service.moderate({ text: "x" }, context)).action).toBe("review");
    expect(recorded[0]).toMatchObject({ action: "review" });
  });

  it("passes images through to the provider, with or without text", async () => {
    await service.moderate({ images: [{ url: "https://img.test/a.png" }] }, context);
    expect(provider.moderate).toHaveBeenLastCalledWith({
      text: undefined,
      images: [{ url: "https://img.test/a.png" }],
    });

    await service.moderate({ text: "caption", images: [{ url: "https://img.test/b.png" }] }, context);
    expect(provider.moderate).toHaveBeenLastCalledWith({
      text: "caption",
      images: [{ url: "https://img.test/b.png" }],
    });
  });

  it("caps very long text before sending it", async () => {
    await service.moderate({ text: "a".repeat(MAX_MODERATED_TEXT_CHARS + 5000) }, context);
    const sent = provider.moderate.mock.calls[0][0].text as string;
    expect(sent).toHaveLength(MAX_MODERATED_TEXT_CHARS);
  });

  it("flags sexual content involving minors for escalation", async () => {
    provider.moderate.mockResolvedValue(flagged("sexual/minors"));

    const decision = await service.moderate({ images: [{ url: "https://img.test/a.png" }] }, context);

    expect(decision).toMatchObject({ action: "reject", escalate: true });
    expect(recorded[0].escalate).toBe(true);
  });
});

describe("failing closed", () => {
  it("never allows content when the provider is down: it is held and marked degraded", async () => {
    provider.moderate.mockRejectedValue(new ModerationUnavailableError());

    const decision = await service.moderate({ text: "anything" }, context);

    expect(decision).toMatchObject({ action: "review", degraded: true, reasons: ["moderation_unavailable"] });
  });

  it("records an outage as degraded, so a missing verdict is visible", async () => {
    provider.moderate.mockRejectedValue(new ModerationUnavailableError());
    await service.moderate({ text: "anything" }, context);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "review", degraded: true }));
  });

  it("rejects content the provider cannot read, and records it", async () => {
    provider.moderate.mockRejectedValue(new ModerationInputError());

    const decision = await service.moderate({ images: [{ url: "https://img.test/corrupt.png" }] }, context);

    expect(decision).toMatchObject({ action: "reject", degraded: false, reasons: ["unprocessable_input"] });
    expect(recorded).toHaveLength(1);
  });

  it("treats an unexpected provider bug like an outage, not an approval", async () => {
    provider.moderate.mockRejectedValue(new TypeError("cannot read properties of undefined"));
    const decision = await service.moderate({ text: "x" }, context);
    expect(decision).toMatchObject({ action: "review", degraded: true });
  });

  it("still returns the decision when the audit trail itself fails", async () => {
    provider.moderate.mockResolvedValue(flagged("sexual"));
    audit.record.mockRejectedValue(new Error("database down"));

    await expect(service.moderate({ text: "x" }, context)).resolves.toMatchObject({ action: "reject" });
  });

  it("works without any audit sink configured", async () => {
    provider.moderate.mockResolvedValue(flagged("sexual"));
    const bare = new ModerationService(provider, new ModerationPolicy());
    await expect(bare.moderate({ text: "x" }, context)).resolves.toMatchObject({ action: "reject" });
  });
});
