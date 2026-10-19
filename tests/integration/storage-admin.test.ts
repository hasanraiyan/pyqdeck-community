import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addClerkUser, as, clerkUsers } from "../helpers/clerk.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";

vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);

const { createApp } = await import("../../src/app.js");
const { StorageAccountModel } = await import("../../src/modules/storage/storage-account.model.js");
const { AccountModel } = await import("../../src/modules/accounts/account.model.js");

const app = createApp();
const GB = 1024 ** 3;
const memoryAccount = (over: Record<string, unknown> = {}) => ({
  name: "mem-1",
  provider: "memory",
  credentials: {},
  capacityBytes: 2 * GB,
  ...over,
});

beforeAll(async () => {
  await connectTestDb();
  await AccountModel.init();
  await StorageAccountModel.init();
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  clerkUsers.clear();
  addClerkUser("user_admin", { email: "boss@example.com" }); // allow-listed in vitest.config, so admin
  addClerkUser("user_member", { email: "member@example.com" });
});

describe("access control", () => {
  it("401 for anonymous callers", async () => {
    await request(app).get("/api/v1/admin/storage/accounts").expect(401);
  });

  it("403 for members", async () => {
    await request(app).get("/api/v1/admin/storage/accounts").set(as("user_member")).expect(403);
    await request(app).post("/api/v1/admin/storage/accounts").set(as("user_member")).send(memoryAccount()).expect(403);
  });

  it("allows admins", async () => {
    await request(app).get("/api/v1/admin/storage/accounts").set(as("user_admin")).expect(200);
  });
});

describe("POST /api/v1/admin/storage/accounts (plugging in a new account)", () => {
  const add = (body: object) => request(app).post("/api/v1/admin/storage/accounts").set(as("user_admin")).send(body);

  it("creates an account without ever returning credentials", async () => {
    const res = await add(memoryAccount({ credentials: { quotaBytes: 500 } })).expect(201);

    expect(res.body.data).toMatchObject({
      name: "mem-1",
      provider: "memory",
      status: "active",
      usedBytes: 0,
      usedPercent: 0,
      capacityBytes: 2 * GB,
    });
    expect(JSON.stringify(res.body)).not.toContain("quotaBytes");
    expect(res.body.data).not.toHaveProperty("credentials");
  });

  it("stores credentials encrypted, not as plaintext", async () => {
    await add(memoryAccount({ credentials: { quotaBytes: 123456 } })).expect(201);
    const stored = await StorageAccountModel.findOne({ name: "mem-1" }).select("+credentials");
    expect(stored!.credentials).toMatch(/^v1\./);
    expect(stored!.credentials).not.toContain("123456");
  });

  it("rejects unknown providers and lists the available ones", async () => {
    const res = await add(memoryAccount({ provider: "dropbox" })).expect(400);
    expect(res.body.details.available).toEqual(expect.arrayContaining(["cloudinary", "memory"]));
  });

  it("rejects credentials that do not match the provider", async () => {
    const res = await add(memoryAccount({ provider: "cloudinary", credentials: { cloudName: "x" } })).expect(400);
    expect(Object.keys(res.body.details)).toEqual(expect.arrayContaining(["apiKey", "apiSecret"]));
  });

  it("rejects a duplicate name with 409", async () => {
    await add(memoryAccount()).expect(201);
    await add(memoryAccount()).expect(409);
  });

  it.each([{ capacityBytes: 0 }, { capacityBytes: -5 }, { name: "" }, { priority: -1 }])(
    "validates the body: %o",
    async (bad) => {
      await add(memoryAccount(bad)).expect(400);
    },
  );
});

describe("listing and updating", () => {
  const createdId = async (over: Record<string, unknown> = {}) =>
    (
      await request(app)
        .post("/api/v1/admin/storage/accounts")
        .set(as("user_admin"))
        .send(memoryAccount(over))
        .expect(201)
    ).body.data.id as string;

  const patch = (id: string, body: object) =>
    request(app).patch(`/api/v1/admin/storage/accounts/${id}`).set(as("user_admin")).send(body);

  it("lists accounts in fill order", async () => {
    await createdId({ name: "late", priority: 9 });
    await createdId({ name: "early", priority: 1 });
    const res = await request(app).get("/api/v1/admin/storage/accounts").set(as("user_admin")).expect(200);
    expect(res.body.data.map((a: { name: string }) => a.name)).toEqual(["early", "late"]);
  });

  it("lists the supported provider types", async () => {
    const res = await request(app).get("/api/v1/admin/storage/providers").set(as("user_admin")).expect(200);
    expect(res.body.data).toEqual(expect.arrayContaining(["cloudinary", "memory"]));
  });

  it("disables and re-enables an account", async () => {
    const id = await createdId();
    expect((await patch(id, { status: "disabled" }).expect(200)).body.data.status).toBe("disabled");
    expect((await patch(id, { status: "active" }).expect(200)).body.data.status).toBe("active");
  });

  it("does not let an admin set the system-only 'full' status", async () => {
    await patch(await createdId(), { status: "full" }).expect(400);
  });

  it("rejects an empty update and 404s for unknown accounts", async () => {
    await patch(await createdId(), {}).expect(400);
    await patch("000000000000000000000000", { priority: 1 }).expect(404);
  });

  it("refresh-usage corrects drift and re-opens a full account that has room", async () => {
    const id = await createdId();
    await StorageAccountModel.updateOne({ _id: id }, { usedBytes: 999_999, status: "full" });

    const res = await request(app)
      .post(`/api/v1/admin/storage/accounts/${id}/refresh-usage`)
      .set(as("user_admin"))
      .expect(200);

    expect(res.body.data).toMatchObject({ usedBytes: 0, status: "active" });
    expect(res.body.data.lastSyncedAt).toBeTruthy();
  });
});
