import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const { UserModel } = await import("../../src/modules/users/user.model.js");

const app = createApp();
const as = (clerkId: string) => ({ "x-test-user": clerkId });
const addClerkUser = (id: string, u: Partial<FakeClerkUser> & { email: string }) =>
  mocks.clerkUsers.set(id, { verified: true, name: "Test User", username: null, ...u });

beforeAll(async () => {
  await connectTestDb();
  await UserModel.init();
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  mocks.clerkUsers.clear();
  mocks.verifyWebhook.mockReset();
});

describe("requireAuth", () => {
  it("returns 401 when signed out", async () => {
    const res = await request(app).get("/api/users/me").expect(401);
    expect(res.body).toMatchObject({ success: false, message: "Sign in to continue" });
  });

  it("returns 401 when Clerk has no such account", async () => {
    await request(app).get("/api/users/me").set(as("user_ghost")).expect(401);
  });

  it("does not block public routes for anonymous callers", async () => {
    await request(app).get("/api/health").expect(200);
  });

  it("returns 403 for a suspended account", async () => {
    addClerkUser("user_s", { email: "s@example.com" });
    await request(app).get("/api/users/me").set(as("user_s")).expect(200);
    await UserModel.updateOne({ clerkId: "user_s" }, { status: "suspended" });
    await request(app).get("/api/users/me").set(as("user_s")).expect(403);
  });

  it("returns 401 for a deleted account", async () => {
    addClerkUser("user_d", { email: "d@example.com" });
    await request(app).get("/api/users/me").set(as("user_d")).expect(200);
    await UserModel.updateOne({ clerkId: "user_d" }, { status: "deleted" });
    await request(app).get("/api/users/me").set(as("user_d")).expect(401);
  });
});

describe("profile creation on first sign-in (identity comes from Clerk)", () => {
  it("copies username, name, avatar and email from Clerk", async () => {
    addClerkUser("user_1", { email: "Jane.Doe@Example.com", name: "Jane Doe", username: "JaneD" });
    const res = await request(app).get("/api/users/me").set(as("user_1")).expect(200);
    expect(res.body.data).toMatchObject({
      username: "janed",
      displayName: "Jane Doe",
      avatarUrl: "https://img.test/a.png",
      email: "jane.doe@example.com",
      role: "member",
      status: "active",
    });
  });

  it("falls back to a username derived from the email when Clerk has none", async () => {
    addClerkUser("user_1", { email: "jane.doe@example.com", username: null });
    const res = await request(app).get("/api/users/me").set(as("user_1")).expect(200);
    expect(res.body.data.username).toBe("janedoe");
  });

  it("does not adopt a reserved Clerk username (staff impersonation)", async () => {
    addClerkUser("user_1", { email: "mallory@example.com", username: "Admin" });
    const res = await request(app).get("/api/users/me").set(as("user_1")).expect(200);
    expect(res.body.data.username).toBe("mallory");
    expect(res.body.data.role).toBe("member");
  });

  it("gives colliding fallback usernames distinct values", async () => {
    addClerkUser("user_a", { email: "sam@one.com" });
    addClerkUser("user_b", { email: "sam@two.com" });
    const a = await request(app).get("/api/users/me").set(as("user_a")).expect(200);
    const b = await request(app).get("/api/users/me").set(as("user_b")).expect(200);
    expect(a.body.data.username).toBe("sam");
    expect(b.body.data.username).toMatch(/^sam\d{4}$/);
  });

  it("avoids reserved names in the fallback", async () => {
    addClerkUser("user_adm", { email: "admin@example.com" });
    const res = await request(app).get("/api/users/me").set(as("user_adm")).expect(200);
    expect(res.body.data.username).not.toBe("admin");
  });

  it("is idempotent and race-safe", async () => {
    addClerkUser("user_1", { email: "jane@example.com" });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).get("/api/users/me").set(as("user_1"))),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await UserModel.countDocuments({ clerkId: "user_1" })).toBe(1);
  });

  it("grants admin to an allow-listed VERIFIED email", async () => {
    addClerkUser("user_boss", { email: "boss@example.com", verified: true });
    const res = await request(app).get("/api/users/me").set(as("user_boss")).expect(200);
    expect(res.body.data.role).toBe("admin");
  });

  it("does NOT grant admin for an unverified email", async () => {
    addClerkUser("user_fake", { email: "boss@example.com", verified: false });
    const res = await request(app).get("/api/users/me").set(as("user_fake")).expect(200);
    expect(res.body.data.role).toBe("member");
  });
});

describe("PATCH /api/users/me", () => {
  beforeEach(() => addClerkUser("user_1", { email: "jane@example.com", name: "Jane", username: "jane" }));

  it("updates headline and bio", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set(as("user_1"))
      .send({ headline: "ECE student", bio: "hello" })
      .expect(200);
    expect(res.body.data).toMatchObject({ headline: "ECE student", bio: "hello" });
  });

  it("ignores Clerk-managed and protected fields", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set(as("user_1"))
      .send({
        bio: "x",
        username: "hacker",
        displayName: "Hacker",
        avatarUrl: "https://evil.test/x.png",
        role: "admin",
        email: "evil@example.com",
        status: "active",
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      username: "jane",
      displayName: "Jane",
      avatarUrl: "https://img.test/a.png",
      role: "member",
      email: "jane@example.com",
    });
  });

  it("rejects an empty update and over-long values", async () => {
    await request(app).patch("/api/users/me").set(as("user_1")).send({}).expect(400);
    await request(app)
      .patch("/api/users/me")
      .set(as("user_1"))
      .send({ bio: "x".repeat(501) })
      .expect(400);
  });

  it("requires sign-in", async () => {
    await request(app).patch("/api/users/me").send({ bio: "x" }).expect(401);
  });
});

describe("GET /api/users/:username (public)", () => {
  beforeEach(async () => {
    addClerkUser("user_1", { email: "jane@example.com", name: "Jane", username: "jane-doe" });
    await request(app).get("/api/users/me").set(as("user_1"));
  });

  it("shows a public profile without private fields", async () => {
    const res = await request(app).get("/api/users/jane-doe").expect(200);
    expect(res.body.data).toMatchObject({ username: "jane-doe", displayName: "Jane", role: "member" });
    expect(res.body.data).not.toHaveProperty("email");
    expect(res.body.data).not.toHaveProperty("clerkId");
    expect(res.body.data).not.toHaveProperty("status");
  });

  it("is case-insensitive and 404s for unknown users", async () => {
    await request(app).get("/api/users/JANE-DOE").expect(200);
    await request(app).get("/api/users/nobody").expect(404);
  });

  it("does not treat /me as a username", async () => {
    await request(app).get("/api/users/me").expect(401);
  });
});

describe("POST /api/webhooks/clerk", () => {
  const post = () => request(app).post("/api/webhooks/clerk").set("content-type", "application/json").send("{}");

  it("rejects a bad signature with 400", async () => {
    mocks.verifyWebhook.mockRejectedValueOnce(new Error("bad signature"));
    await post().expect(400);
  });

  it("creates the profile on user.created", async () => {
    addClerkUser("user_w", { email: "wh@example.com", username: "wh" });
    mocks.verifyWebhook.mockResolvedValueOnce({ type: "user.created", data: { id: "user_w" } });
    await post().expect(200);
    expect(await UserModel.findOne({ clerkId: "user_w" })).toMatchObject({ username: "wh" });
  });

  it("syncs username, name, avatar and email from Clerk on user.updated, keeping community fields", async () => {
    addClerkUser("user_w", { email: "old@example.com", name: "Old Name", username: "old_name" });
    await request(app).patch("/api/users/me").set(as("user_w")).send({ bio: "mine" }).expect(200);

    addClerkUser("user_w", { email: "new@example.com", name: "New Name", username: "new_name" });
    mocks.verifyWebhook.mockResolvedValueOnce({ type: "user.updated", data: { id: "user_w" } });
    await post().expect(200);

    expect(await UserModel.findOne({ clerkId: "user_w" })).toMatchObject({
      email: "new@example.com",
      displayName: "New Name",
      username: "new_name",
      bio: "mine",
    });
  });

  it("keeps the old username (and still syncs the rest) when the new Clerk username clashes", async () => {
    addClerkUser("user_x", { email: "sam@example.com" }); // fallback handle "sam"
    await request(app).get("/api/users/me").set(as("user_x")).expect(200);
    addClerkUser("user_w", { email: "w@example.com", name: "W", username: "w_user" });
    await request(app).get("/api/users/me").set(as("user_w")).expect(200);

    addClerkUser("user_w", { email: "w@example.com", name: "W Renamed", username: "sam" });
    mocks.verifyWebhook.mockResolvedValueOnce({ type: "user.updated", data: { id: "user_w" } });
    await post().expect(200);

    expect(await UserModel.findOne({ clerkId: "user_w" })).toMatchObject({
      username: "w_user",
      displayName: "W Renamed",
    });
  });

  it("scrubs personal data and frees the handle on user.deleted", async () => {
    addClerkUser("user_w", { email: "gone@example.com", name: "Gone Person", username: "gone" });
    await request(app).patch("/api/users/me").set(as("user_w")).send({ bio: "secret bio" }).expect(200);
    mocks.verifyWebhook.mockResolvedValueOnce({ type: "user.deleted", data: { id: "user_w" } });
    await post().expect(200);

    const doc = await UserModel.findOne({ clerkId: "user_w" });
    expect(doc).toMatchObject({ status: "deleted", displayName: "Deleted user", bio: "", avatarUrl: "" });
    expect(doc?.email).not.toContain("gone@example.com");
    await request(app).get("/api/users/gone").expect(404);
  });

  it("is idempotent for repeated deletes", async () => {
    mocks.verifyWebhook.mockResolvedValue({ type: "user.deleted", data: { id: "user_never_seen" } });
    await post().expect(200);
    await post().expect(200);
  });
});
