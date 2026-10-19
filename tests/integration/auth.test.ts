import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE, seedCommunity } from "../helpers/community.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";

interface FakeClerkUser {
  email: string;
  verified: boolean;
  name: string;
  username: string | null;
}

const mocks = vi.hoisted(() => ({
  clerkUsers: new Map<string, FakeClerkUser>(),
  verifyWebhook: vi.fn(),
}));

// Stand-in for Clerk: the "session" is just an x-test-user header carrying the Clerk user id.
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: (req: { headers: Record<string, string | undefined> }) => ({ userId: req.headers["x-test-user"] ?? null }),
  clerkClient: {
    users: {
      getUser: async (id: string) => {
        const u = mocks.clerkUsers.get(id);
        if (!u) throw new Error("not found");
        return {
          primaryEmailAddress: {
            emailAddress: u.email,
            verification: { status: u.verified ? "verified" : "unverified" },
          },
          fullName: u.name,
          username: u.username,
          imageUrl: "https://img.test/a.png",
        };
      },
    },
  },
}));
vi.mock("@clerk/express/webhooks", () => ({ verifyWebhook: mocks.verifyWebhook }));

const { createApp } = await import("../../src/app.js");
const { AccountModel } = await import("../../src/modules/accounts/account.model.js");
const { MemberModel } = await import("../../src/modules/members/member.model.js");
const { CommunityModel } = await import("../../src/modules/communities/community.model.js");

const app = createApp();
const as = (clerkId: string) => ({ "x-test-user": clerkId });
const addClerkUser = (id: string, u: Partial<FakeClerkUser> & { email: string }) =>
  mocks.clerkUsers.set(id, { verified: true, name: "Test User", username: null, ...u });

beforeAll(async () => {
  await connectTestDb();
  await Promise.all([AccountModel.init(), MemberModel.init(), CommunityModel.init()]);
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seedCommunity();
  mocks.clerkUsers.clear();
  mocks.verifyWebhook.mockReset();
});

const me = (clerkId?: string) => {
  const r = request(app).get(`${BASE()}/members/me`);
  return clerkId ? r.set(as(clerkId)) : r;
};

describe("requireAuth", () => {
  it("returns 401 when signed out", async () => {
    const res = await me().expect(401);
    expect(res.body).toMatchObject({ success: false, message: "Sign in to continue" });
  });

  it("returns 401 when Clerk has no such account", async () => {
    await me("user_ghost").expect(401);
  });

  it("does not block public routes for anonymous callers", async () => {
    await request(app).get("/api/health").expect(200);
  });

  it("returns 403 for a member suspended in this community", async () => {
    addClerkUser("user_s", { email: "s@example.com" });
    await me("user_s").expect(200);
    await MemberModel.updateOne({}, { status: "suspended" });
    await me("user_s").expect(403);
  });

  it("lets a temporary suspension lapse without any job", async () => {
    addClerkUser("user_s", { email: "s@example.com" });
    await me("user_s").expect(200);
    await MemberModel.updateOne({}, { status: "suspended", suspendedUntil: new Date(Date.now() - 1000) });
    await me("user_s").expect(200);
  });

  it("returns 401 for a deleted member", async () => {
    addClerkUser("user_d", { email: "d@example.com" });
    await me("user_d").expect(200);
    await MemberModel.updateOne({}, { status: "deleted" });
    await me("user_d").expect(401);
  });
});

describe("membership creation on first action (identity comes from Clerk)", () => {
  it("prefills handle, name and avatar from Clerk and keeps the email private to the owner", async () => {
    addClerkUser("user_1", { email: "Jane.Doe@Example.com", name: "Jane Doe", username: "JaneD" });
    const res = await me("user_1").expect(200);
    expect(res.body.data).toMatchObject({
      username: "janed",
      displayName: "Jane Doe",
      avatarUrl: "https://img.test/a.png",
      email: "jane.doe@example.com",
      role: "member",
      status: "active",
    });
  });

  it("falls back to a handle derived from the email when Clerk has none", async () => {
    addClerkUser("user_1", { email: "jane.doe@example.com", username: null });
    expect((await me("user_1").expect(200)).body.data.username).toBe("janedoe");
  });

  it("does not adopt a reserved Clerk username (staff impersonation)", async () => {
    addClerkUser("user_1", { email: "mallory@example.com", username: "Admin" });
    const res = await me("user_1").expect(200);
    expect(res.body.data.username).toBe("mallory");
    expect(res.body.data.role).toBe("member");
  });

  it("gives colliding fallback handles distinct values", async () => {
    addClerkUser("user_a", { email: "sam@one.com" });
    addClerkUser("user_b", { email: "sam@two.com" });
    expect((await me("user_a").expect(200)).body.data.username).toBe("sam");
    expect((await me("user_b").expect(200)).body.data.username).toMatch(/^sam\d{4}$/);
  });

  it("is idempotent and race-safe", async () => {
    addClerkUser("user_1", { email: "jane@example.com" });
    const results = await Promise.all(Array.from({ length: 5 }, () => me("user_1")));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await MemberModel.countDocuments()).toBe(1);
    expect(await AccountModel.countDocuments({ clerkId: "user_1" })).toBe(1);
  });

  it("grants admin to an allow-listed VERIFIED email, and not to an unverified one", async () => {
    addClerkUser("user_boss", { email: "boss@example.com", verified: true });
    expect((await me("user_boss").expect(200)).body.data).toMatchObject({ role: "admin", isPlatformAdmin: true });
    addClerkUser("user_fake", { email: "boss@example.com", verified: false });
    expect((await me("user_fake").expect(200)).body.data).toMatchObject({ role: "member", isPlatformAdmin: false });
  });
});

describe("communities are isolated and unlinked", () => {
  beforeEach(async () => {
    await seedCommunity("gate");
    addClerkUser("user_1", { email: "jane@example.com", name: "Jane", username: "jane" });
  });

  it("gives the same person a separate membership in each community", async () => {
    await me("user_1").expect(200);
    await request(app)
      .patch(`${BASE()}/members/me`)
      .set(as("user_1"))
      .send({ username: "jane_beu", bio: "BEU student" })
      .expect(200);
    const gate = (
      await request(app)
        .get(`${BASE("gate")}/members/me`)
        .set(as("user_1"))
        .expect(200)
    ).body.data;
    expect(gate).toMatchObject({ username: "jane", bio: "" }); // not carried over from beu
    expect(await MemberModel.countDocuments()).toBe(2);
  });

  it("lets the same handle exist in two communities but not twice in one", async () => {
    addClerkUser("user_2", { email: "joe@example.com", username: "joe" });
    await me("user_2").expect(200);
    await request(app)
      .get(`${BASE("gate")}/members/me`)
      .set(as("user_2"))
      .expect(200);
    await me("user_1").expect(200);
    await request(app).patch(`${BASE()}/members/me`).set(as("user_1")).send({ username: "joe" }).expect(409);
    // a profile in beu is invisible from gate
    await request(app)
      .get(`${BASE("gate")}/members/jane`)
      .expect(404);
  });

  it("answers 404 for unknown and disabled communities without revealing others", async () => {
    await request(app)
      .get(`${BASE("nope")}/members/me`)
      .expect(404);
    await CommunityModel.updateOne({ slug: "gate" }, { status: "disabled" });
    await request(app)
      .get(`${BASE("gate")}/members/me`)
      .set(as("user_1"))
      .expect(404);
  });

  it("refuses writes in a read-only community but keeps serving reads", async () => {
    await CommunityModel.updateOne({ slug: "gate" }, { status: "read_only" });
    await request(app)
      .get(`${BASE("gate")}/members/me`)
      .set(as("user_1"))
      .expect(200);
    await request(app)
      .patch(`${BASE("gate")}/members/me`)
      .set(as("user_1"))
      .send({ bio: "x" })
      .expect(403);
  });
});

describe("PATCH /members/me", () => {
  beforeEach(() => addClerkUser("user_1", { email: "jane@example.com", name: "Jane", username: "jane" }));
  const patch = (body: object) => request(app).patch(`${BASE()}/members/me`).set(as("user_1")).send(body);

  it("updates the persona fields", async () => {
    const res = await patch({
      displayName: "Jane D",
      headline: "ECE student",
      bio: "hello",
      location: "Patna",
      github: "@janed",
      skills: ["C", "Networks"],
      attributes: { branch: "ece", semester: 5 },
    }).expect(200);
    expect(res.body.data).toMatchObject({
      displayName: "Jane D",
      headline: "ECE student",
      bio: "hello",
      location: "Patna",
      github: "janed",
      skills: ["C", "Networks"],
      attributes: { branch: "ece", semester: 5 },
    });
  });

  it("refuses fields nobody may set through this API", async () => {
    for (const body of [
      { role: "admin" },
      { status: "active" },
      { email: "evil@example.com" },
      { followersCount: 9999 },
    ]) {
      await patch(body).expect(400);
    }
  });

  it("rejects reserved handles, bad social handles and non-https websites", async () => {
    await patch({ username: "admin" }).expect(400);
    await patch({ twitter: "not a handle!" }).expect(400);
    await patch({ website: "http://example.com" }).expect(400);
    await patch({ website: "javascript:alert(1)" }).expect(400);
    await patch({ website: "https://example.com/me" }).expect(200);
  });

  it("rejects an empty update and over-long values", async () => {
    await patch({}).expect(400);
    await patch({ bio: "x".repeat(501) }).expect(400);
    await patch({ skills: Array.from({ length: 11 }, (_, i) => `s${i}`) }).expect(400);
  });

  it("requires sign-in", async () => {
    await request(app).patch(`${BASE()}/members/me`).send({ bio: "x" }).expect(401);
  });
});

describe("GET /members/:username (public)", () => {
  beforeEach(async () => {
    addClerkUser("user_1", { email: "jane@example.com", name: "Jane", username: "jane-doe" });
    await me("user_1");
  });

  it("shows a public profile without private fields", async () => {
    const res = await request(app).get(`${BASE()}/members/jane-doe`).expect(200);
    expect(res.body.data).toMatchObject({ username: "jane-doe", displayName: "Jane", role: "member" });
    for (const secret of ["email", "clerkId", "accountId", "status"]) expect(res.body.data).not.toHaveProperty(secret);
  });

  it("is case-insensitive and 404s for unknown members", async () => {
    await request(app).get(`${BASE()}/members/JANE-DOE`).expect(200);
    await request(app).get(`${BASE()}/members/nobody`).expect(404);
  });

  it("does not treat /me as a handle", async () => {
    await request(app).get(`${BASE()}/members/me`).expect(401);
  });
});

describe("POST /api/webhooks/clerk", () => {
  const post = () => request(app).post("/api/webhooks/clerk").set("content-type", "application/json").send("{}");

  it("rejects a bad signature with 400", async () => {
    mocks.verifyWebhook.mockRejectedValueOnce(new Error("bad signature"));
    await post().expect(400);
  });

  it("creates the account on user.created", async () => {
    addClerkUser("user_w", { email: "wh@example.com", username: "wh" });
    mocks.verifyWebhook.mockResolvedValueOnce({ type: "user.created", data: { id: "user_w" } });
    await post().expect(200);
    expect(await AccountModel.findOne({ clerkId: "user_w" })).toMatchObject({ email: "wh@example.com" });
  });

  it("syncs the Clerk snapshot on user.updated without touching an existing persona", async () => {
    addClerkUser("user_w", { email: "old@example.com", name: "Old Name", username: "old_name" });
    await me("user_w").expect(200);
    await request(app)
      .patch(`${BASE()}/members/me`)
      .set(as("user_w"))
      .send({ bio: "mine", displayName: "My Name" })
      .expect(200);

    addClerkUser("user_w", { email: "new@example.com", name: "New Name", username: "new_name" });
    mocks.verifyWebhook.mockResolvedValueOnce({ type: "user.updated", data: { id: "user_w" } });
    await post().expect(200);

    expect(await AccountModel.findOne({ clerkId: "user_w" })).toMatchObject({
      email: "new@example.com",
      clerkProfile: { displayName: "New Name", username: "new_name" },
    });
    expect(await MemberModel.findOne({})).toMatchObject({ displayName: "My Name", username: "old_name", bio: "mine" });
  });

  it("scrubs the account and every membership, and frees the handle, on user.deleted", async () => {
    await seedCommunity("gate");
    addClerkUser("user_w", { email: "gone@example.com", name: "Gone Person", username: "gone" });
    await me("user_w").expect(200);
    await request(app)
      .get(`${BASE("gate")}/members/me`)
      .set(as("user_w"))
      .expect(200);
    await request(app).patch(`${BASE()}/members/me`).set(as("user_w")).send({ bio: "secret bio" }).expect(200);

    mocks.verifyWebhook.mockResolvedValueOnce({ type: "user.deleted", data: { id: "user_w" } });
    await post().expect(200);

    const members = await MemberModel.find({});
    expect(members).toHaveLength(2);
    for (const m of members) {
      expect(m).toMatchObject({ status: "deleted", displayName: "Deleted user", bio: "", avatarUrl: "" });
    }
    const account = await AccountModel.findOne({ clerkId: "user_w" });
    expect(account).toMatchObject({ status: "deleted" });
    expect(account?.email).not.toContain("gone@example.com");
    await request(app).get(`${BASE()}/members/gone`).expect(404);
  });

  it("is idempotent for repeated deletes", async () => {
    mocks.verifyWebhook.mockResolvedValue({ type: "user.deleted", data: { id: "user_never_seen" } });
    await post().expect(200);
    await post().expect(200);
  });
});
