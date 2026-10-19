import { describe, expect, it, vi } from "vitest";
import { ModerationPolicy } from "../../src/modules/moderation/moderation.policy.js";
import {
  MAX_SNAPSHOT_CHARS,
  ModerationService,
  snapshotContent,
} from "../../src/modules/moderation/moderation.service.js";
import type {
  ModerationAudit,
  ModerationEventInput,
  ModerationProvider,
} from "../../src/modules/moderation/moderation.types.js";

describe("snapshotContent", () => {
  it("keeps the text and the links of the images", () => {
    expect(snapshotContent({ text: "  hello  ", images: [{ url: "https://img/a.png" }] }, false)).toEqual({
      text: "hello",
      imageUrls: ["https://img/a.png"],
    });
  });

  it("cuts very long text", () => {
    expect(snapshotContent({ text: "x".repeat(MAX_SNAPSHOT_CHARS + 500) }, false).text).toHaveLength(
      MAX_SNAPSHOT_CHARS,
    );
  });

  it("has no link to keep for an image sent as raw bytes, and nothing for empty input", () => {
    expect(snapshotContent({ images: [{ data: Buffer.from("x"), mimeType: "image/png" }] }, false)).toEqual({});
    expect(snapshotContent({ text: "   " }, false)).toEqual({});
  });

  it("keeps NOTHING for child-safety results", () => {
    expect(snapshotContent({ text: "bad", images: [{ url: "https://img/a.png" }] }, true)).toEqual({});
  });
});

describe("what the service records", () => {
  const setup = (categories: Record<string, boolean>) => {
    const recorded: ModerationEventInput[] = [];
    const audit: ModerationAudit = { record: vi.fn(async (e) => void recorded.push(e)) };
    const provider: ModerationProvider = {
      name: "fake",
      moderate: vi.fn(async () => ({ flagged: Object.values(categories).some(Boolean), categories, scores: {} })),
    };
    return { recorded, service: new ModerationService(provider, new ModerationPolicy(), audit) };
  };

  it("stores the text and image links of an allowed submission, so moderators can see what the result was about", async () => {
    const { recorded, service } = setup({});
    await service.moderate({ text: "explain Dijkstra", images: [{ url: "https://img/a.png" }] }, { source: "post" });
    expect(recorded[0]).toMatchObject({ action: "allow", text: "explain Dijkstra", imageUrls: ["https://img/a.png"] });
  });

  it("never stores the content of a child-safety result", async () => {
    const { recorded, service } = setup({ "sexual/minors": true });
    const decision = await service.moderate(
      { text: "something", images: [{ url: "https://img/a.png" }] },
      { source: "media" },
    );
    expect(decision.escalate).toBe(true);
    expect(recorded[0]).toMatchObject({ action: "reject", escalate: true });
    expect(recorded[0]).not.toHaveProperty("text");
    expect(recorded[0]).not.toHaveProperty("imageUrls");
  });
});
