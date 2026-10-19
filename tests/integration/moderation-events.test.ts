import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addClerkUser, as, clerkUsers } from "../helpers/clerk.js";
import { BASE, communityIdOf, seedCommunity, setMemberRole } from "../helpers/community.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";

vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);

const { createApp } = await import("../../src/app.js");
const { ModerationEventModel } = await import("../../src/modules/moderation/moderation-event.model.js");
const { ModerationEventRepository } = await import("../../src/modules/moderation/moderation-event.repository.js");
const { ModerationPolicy } = await import("../../src/modules/moderation/moderation.policy.js");
const { ModerationService } = await import("../../src/modules/moderation/moderation.service.js");
const { MemberModel } = await import("../../src/modules/members/member.model.js");

const app = createApp();
const repository = new ModerationEventRepository();

let cid = "";
const event = (over: Record<string, unknown> = {}) => ({
  communityId: cid,
  source: "media",
  action: "reject" as const,
  degraded: false,
  escalate: false,
  categories: ["sexual"],
  scores: { sexual: 0.97 },
  provider: "openai",
  ...over,
});

beforeAll(async () => {
  await connectTestDb();
  await Promise.all([MemberModel.init(), ModerationEventModel.init()]);
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seedCommunity();
  cid = await communityIdOf();
  clerkUsers.clear();
  addClerkUser("user_member", { email: "member@example.com" });
  addClerkUser("user_mod", { email: "mod@example.com" });
  addClerkUser("user_admin", { email: "boss@example.com" }); // allow-listed in vitest.config, so admin
  await request(app).get(`${BASE()}/members/me`).set(as("user_member"));
  await request(app).get(`${BASE()}/members/me`).set(as("user_mod"));
  await setMemberRole("user_mod", "moderator");
});

describe("GET /moderation/events (access)", () => {
  it("is closed to anonymous callers and plain members", async () => {
    await request(app).get(`${BASE()}/moderation/events`).expect(401);
    await request(app).get(`${BASE()}/moderation/events`).set(as("user_member")).expect(403);
  });

  it("is open to moderators and admins", async () => {
    await request(app).get(`${BASE()}/moderation/events`).set(as("user_mod")).expect(200);
    await request(app).get(`${BASE()}/moderation/events`).set(as("user_admin")).expect(200);
  });
});

describe("GET /moderation/events (listing)", () => {
  beforeEach(async () => {
    await repository.record(event({ source: "media", action: "reject" }));
    await repository.record(event({ source: "post", action: "review", categories: ["harassment"] }));
    await repository.record(
      event({ source: "media", action: "reject", escalate: true, categories: ["sexual/minors"] }),
    );
  });

  const list = (qs = "") => request(app).get(`${BASE()}/moderation/events${qs}`).set(as("user_mod"));

  it("returns events newest first with pagination", async () => {
    const res = await list().expect(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination).toMatchObject({ total: 3, page: 1 });
    const times = res.body.data.map((e: { createdAt: string }) => Date.parse(e.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("filters by action, source and escalation", async () => {
    expect((await list("?action=review").expect(200)).body.data).toHaveLength(1);
    expect((await list("?source=media").expect(200)).body.data).toHaveLength(2);
    const escalated = (await list("?escalate=true").expect(200)).body.data;
    expect(escalated).toHaveLength(1);
    expect(escalated[0].categories).toEqual(["sexual/minors"]);
  });

  it("paginates", async () => {
    const res = await list("?limit=2&page=2").expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ total: 3, totalPages: 2, hasPrev: true, hasNext: false });
  });

  it.each(["?action=allow", "?limit=101", "?escalate=maybe", "?userId=not-an-id"])("rejects %s", async (qs) => {
    await list(qs).expect(400);
  });
});

describe("recording", () => {
  it("never stores an allow", async () => {
    await repository.record({ ...event(), action: "allow" });
    expect(await ModerationEventModel.countDocuments()).toBe(0);
  });

  it("expires old events on its own (90 day retention)", async () => {
    const indexes = await ModerationEventModel.collection.indexes();
    const ttl = indexes.find((i) => i.key?.createdAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
  });

  it("is written end to end by the real service, without the content", async () => {
    const provider = {
      name: "fake",
      moderate: vi.fn(async () => ({
        flagged: true,
        categories: { hate: true },
        scores: { hate: 0.91 },
      })),
    };
    const service = new ModerationService(provider, new ModerationPolicy(), repository);
    const user = await MemberModel.findOne({}).sort({ createdAt: 1 });

    const decision = await service.moderate(
      { text: "SOME-OFFENSIVE-TEXT-THAT-MUST-NOT-BE-STORED" },
      { userId: user!.id, communityId: cid, source: "comment", sourceId: "c1" },
    );

    expect(decision.action).toBe("reject");
    const stored = await ModerationEventModel.findOne().lean();
    expect(stored).toMatchObject({ source: "comment", sourceId: "c1", action: "reject", categories: ["hate"] });
    expect(String(stored!.communityId)).toBe(cid);
    expect(String(stored!.userId)).toBe(user!.id);
    expect(JSON.stringify(stored)).not.toContain("SOME-OFFENSIVE-TEXT");
  });
});
