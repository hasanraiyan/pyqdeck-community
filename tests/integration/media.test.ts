import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addClerkUser, as, clerkUsers } from "../helpers/clerk.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";
import { GIF, PDF, PNG, WEBP, pngOfSize } from "../helpers/images.js";

vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);

const { createApp } = await import("../../src/app.js");
const { MediaModel } = await import("../../src/modules/media/media.model.js");
const { getMediaService } = await import("../../src/modules/media/media.module.js");
const { StorageAccountModel } = await import("../../src/modules/storage/storage-account.model.js");
const { getStorageAdminService } = await import("../../src/modules/storage/storage.module.js");
const { UserModel } = await import("../../src/modules/users/user.model.js");

const app = createApp();
const GB = 1024 ** 3;

const addAccount = (name: string, over: { priority?: number; quotaBytes?: number; capacityBytes?: number } = {}) =>
  getStorageAdminService().add({
    name,
    provider: "memory",
    credentials: over.quotaBytes ? { quotaBytes: over.quotaBytes } : {},
    capacityBytes: over.capacityBytes ?? GB,
    priority: over.priority,
  });

const accountState = async (name: string) => (await StorageAccountModel.findOne({ name }))!;

type Upload = { data: Buffer; filename?: string };
const upload = (clerkId: string | null, files: Upload[]) => {
  let req = request(app).post("/api/media");
  if (clerkId) req = req.set(as(clerkId));
  for (const f of files) req = req.attach("files", f.data, { filename: f.filename ?? "photo.png" });
  return req;
};

const userId = async (clerkId: string) =>
  (await request(app).get("/api/users/me").set(as(clerkId)).expect(200)).body.data.id as string;

beforeAll(async () => {
  await connectTestDb();
  await Promise.all([UserModel.init(), StorageAccountModel.init(), MediaModel.init()]);
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  clerkUsers.clear();
  addClerkUser("user_a", { email: "alice@example.com" });
  addClerkUser("user_b", { email: "bob@example.com" });
  addClerkUser("user_admin", { email: "boss@example.com" });
});

describe("POST /api/media", () => {
  beforeEach(async () => {
    await addAccount("primary");
  });

  it("requires sign-in", async () => {
    await upload(null, [{ data: PNG }]).expect(401);
  });

  it("stores an image, returns a safe DTO and counts the bytes against the account", async () => {
    const res = await upload("user_a", [{ data: PNG }]).expect(201);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ mimeType: "image/png", size: PNG.length, status: "pending" });
    expect(res.body.data[0].url).toMatch(/^memory:\/\//);
    for (const secret of ["key", "accountId", "provider", "owner"]) expect(res.body.data[0]).not.toHaveProperty(secret);
    expect((await accountState("primary")).usedBytes).toBe(PNG.length);
  });

  it("accepts the full 8 images and rejects a 9th", async () => {
    await upload("user_a", Array(8).fill({ data: PNG })).expect(201);
    await upload("user_a", Array(9).fill({ data: PNG })).expect(400);
  });

  it("accepts JPEG-compatible mixes of allowed types", async () => {
    const res = await upload("user_a", [{ data: PNG }, { data: WEBP, filename: "x.webp" }]).expect(201);
    expect(res.body.data.map((m: { mimeType: string }) => m.mimeType)).toEqual(["image/png", "image/webp"]);
  });

  it("rejects non-images by content even when the name and type claim otherwise", async () => {
    await upload("user_a", [{ data: PDF, filename: "totally-a-photo.png" }]).expect(400);
    await upload("user_a", [{ data: GIF }]).expect(400);
  });

  it("is all-or-nothing: one bad file means nothing is stored", async () => {
    await upload("user_a", [{ data: PNG }, { data: PDF }]).expect(400);

    expect((await accountState("primary")).usedBytes).toBe(0);
    expect(await MediaModel.countDocuments()).toBe(0);
  });

  it("rejects a request with no files", async () => {
    await request(app).post("/api/media").set(as("user_a")).field("note", "hi").expect(400);
  });

  it("returns 413 for an oversized file", async () => {
    const res = await upload("user_a", [{ data: pngOfSize(8 * 1024 * 1024 + 1024) }]).expect(413);
    expect(res.body.message).toContain("8 MB");
  });
});

describe("storage capacity", () => {
  it("returns 507 and stores nothing when no account exists", async () => {
    const res = await upload("user_a", [{ data: PNG }]).expect(507);
    expect(res.body.success).toBe(false);
    expect(await MediaModel.countDocuments()).toBe(0);
  });

  it("fails over to the next account when the first is over quota, and retires the first", async () => {
    await addAccount("small", { priority: 1, quotaBytes: 10 });
    await addAccount("backup", { priority: 2 });

    await upload("user_a", [{ data: PNG }]).expect(201);

    expect((await accountState("small")).status).toBe("full");
    expect((await accountState("small")).usedBytes).toBe(0);
    expect((await accountState("backup")).usedBytes).toBe(PNG.length);
  });

  it("keeps using the new account afterwards (plug in a new one when the old fills up)", async () => {
    await addAccount("old", { priority: 1, quotaBytes: 10 });
    await upload("user_a", [{ data: PNG }]).expect(507); // everything is full

    await addAccount("new-account", { priority: 2 }); // the admin plugs in a fresh one
    await upload("user_a", [{ data: PNG }]).expect(201);

    expect((await accountState("new-account")).usedBytes).toBe(PNG.length);
  });

  it("rolls back files already stored when a later file in the same request fails", async () => {
    await addAccount("tight", { quotaBytes: PNG.length + 10 }); // room for one image, not two

    await upload("user_a", [{ data: PNG }, { data: PNG }]).expect(507);

    expect(await MediaModel.countDocuments()).toBe(0);
    expect((await accountState("tight")).usedBytes).toBe(0);
  });
});

describe("DELETE /api/media/:id", () => {
  let mediaId: string;
  beforeEach(async () => {
    await addAccount("primary");
    mediaId = (await upload("user_a", [{ data: PNG }]).expect(201)).body.data[0].id;
  });

  it("lets the owner delete an unattached upload and frees the space", async () => {
    await request(app).delete(`/api/media/${mediaId}`).set(as("user_a")).expect(204);

    expect(await MediaModel.countDocuments()).toBe(0);
    expect((await accountState("primary")).usedBytes).toBe(0);
  });

  it("hides other people's uploads behind a 404", async () => {
    await request(app).delete(`/api/media/${mediaId}`).set(as("user_b")).expect(404);
    expect(await MediaModel.countDocuments()).toBe(1);
  });

  it("lets staff delete anyone's upload", async () => {
    await request(app).delete(`/api/media/${mediaId}`).set(as("user_admin")).expect(204);
  });

  it("requires sign-in and 404s for unknown ids", async () => {
    await request(app).delete(`/api/media/${mediaId}`).expect(401);
    await request(app).delete("/api/media/000000000000000000000000").set(as("user_a")).expect(404);
  });

  it("refuses to delete media that belongs to a post", async () => {
    await getMediaService().attach(await userId("user_a"), [mediaId]);
    const res = await request(app).delete(`/api/media/${mediaId}`).set(as("user_a")).expect(409);
    expect(res.body.message).toContain("post");
  });
});

describe("MediaService lifecycle (used by the posts module)", () => {
  const service = () => getMediaService();
  const uploadTwo = async () => {
    const res = await upload("user_a", [{ data: PNG }, { data: WEBP }]).expect(201);
    return res.body.data.map((m: { id: string }) => m.id) as string[];
  };

  beforeEach(async () => {
    await addAccount("primary");
  });

  it("attach claims pending uploads", async () => {
    const ids = await uploadTwo();
    await service().attach(await userId("user_a"), ids);
    expect(await MediaModel.countDocuments({ status: "attached" })).toBe(2);
  });

  it("attach refuses someone else's, missing, or already-used media, and claims nothing", async () => {
    const ids = await uploadTwo();
    const bob = await userId("user_b");
    const alice = await userId("user_a");

    await expect(service().attach(bob, ids)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service().attach(alice, [ids[0], "000000000000000000000000"])).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await MediaModel.countDocuments({ status: "attached" })).toBe(0);

    await service().attach(alice, ids);
    await expect(service().attach(alice, ids)).rejects.toMatchObject({ statusCode: 400 }); // already used
  });

  it("attach enforces the 8 per post limit and rejects malformed ids", async () => {
    const alice = await userId("user_a");
    await expect(
      service().attach(
        alice,
        Array.from({ length: 9 }, (_, i) => `${i}`.padStart(24, "0")),
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(service().attach(alice, ["not-an-id"])).rejects.toMatchObject({ statusCode: 400 });
  });

  it("attach with no ids is a no-op", async () => {
    await expect(service().attach(await userId("user_a"), [])).resolves.toBeUndefined();
  });

  it("release removes the files and records (post deleted)", async () => {
    const ids = await uploadTwo();
    await service().attach(await userId("user_a"), ids);

    await service().release(ids);

    expect(await MediaModel.countDocuments()).toBe(0);
    expect((await accountState("primary")).usedBytes).toBe(0);
  });

  it("cleanupExpired removes only stale pending uploads", async () => {
    const [stale, fresh] = await uploadTwo();
    const [attached] = (await upload("user_a", [{ data: PNG }]).expect(201)).body.data.map((m: { id: string }) => m.id);
    await service().attach(await userId("user_a"), [attached]);

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    // createdAt is immutable in Mongoose, so backdate through the raw driver.
    await MediaModel.collection.updateMany(
      { _id: { $in: [stale, attached].map((id) => new Types.ObjectId(id)) } },
      { $set: { createdAt: twoHoursAgo } },
    );

    expect(await service().cleanupExpired()).toBe(1);

    const remaining = (await MediaModel.find()).map((m) => m.id);
    expect(remaining.sort()).toEqual([fresh, attached].sort());
  });
});
