import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryProvider } from "../../src/modules/storage/providers/memory.provider.js";
import { addClerkUser, as, clerkUsers } from "../helpers/clerk.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";
import { GIF, PNG, pngOfSize } from "../helpers/images.js";

vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);

const { createApp } = await import("../../src/app.js");
const { MediaModel } = await import("../../src/modules/media/media.model.js");
const { getMediaService } = await import("../../src/modules/media/media.module.js");
const { StorageAccountModel } = await import("../../src/modules/storage/storage-account.model.js");
const { getProviderResolver, getStorageAdminService } = await import("../../src/modules/storage/storage.module.js");
const { UserModel } = await import("../../src/modules/users/user.model.js");

const app = createApp();
const GB = 1024 ** 3;

const addAccount = (name: string, over: { priority?: number; capacityBytes?: number } = {}) =>
  getStorageAdminService().add({
    name,
    provider: "memory",
    credentials: {},
    capacityBytes: over.capacityBytes ?? GB,
    priority: over.priority,
  });

const accountState = async (name: string) => (await StorageAccountModel.findOne({ name }))!;

/** The in-memory provider behind an account, so a test can play the part of the app uploading straight to it. */
const providerOf = async (name: string) => {
  const account = await StorageAccountModel.findOne({ name }).select("+credentials");
  return getProviderResolver().forAccount({
    id: account!.id,
    provider: account!.provider,
    encryptedCredentials: account!.credentials,
  }) as MemoryProvider;
};

const userId = async (clerkId: string) =>
  (await request(app).get("/api/users/me").set(as(clerkId)).expect(200)).body.data.id as string;

type Ticket = {
  id: string;
  upload: { method: string; url: string; fields: Record<string, string>; fileField: string };
};

const requestTickets = (clerkId: string | null, files: Array<{ mimeType: string; size: number }>) => {
  let req = request(app).post("/api/media/uploads");
  if (clerkId) req = req.set(as(clerkId));
  return req.send({ files });
};
const complete = (clerkId: string, id: string) => request(app).post(`/api/media/${id}/complete`).set(as(clerkId));
const png = (size = PNG.length) => ({ mimeType: "image/png", size });

/** Asks for one ticket, then plays the app: uploads `data` straight to the provider under the ticket's key. */
const startAndUpload = async (data: Buffer, opts: { declared?: number; mimeType?: string } = {}) => {
  const res = await requestTickets("user_a", [png(opts.declared ?? data.length)]).expect(201);
  const ticket = res.body.data[0] as Ticket;
  (await providerOf("primary")).simulateClientUpload(ticket.upload.fields.key, data, opts.mimeType ?? "image/png");
  return ticket;
};

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
  await addAccount("primary");
});

describe("POST /api/media/uploads", () => {
  it("requires sign-in", async () => {
    await requestTickets(null, [png()]).expect(401);
  });

  it("issues one ticket per file and reserves the declared space, with no bytes reaching the server", async () => {
    const res = await requestTickets("user_a", [png(1000), { mimeType: "image/webp", size: 500 }]).expect(201);

    expect(res.body.data).toHaveLength(2);
    for (const item of res.body.data as Ticket[]) {
      expect(item.id).toMatch(/^[0-9a-f]{24}$/);
      expect(item.upload).toMatchObject({ method: "POST", fileField: "file" });
      expect(item.upload.fields.key).toMatch(/^pyqdeck-community\/media\//);
      for (const internal of ["accountId", "provider", "owner"]) expect(item).not.toHaveProperty(internal);
    }
    expect((await accountState("primary")).usedBytes).toBe(1500);
    expect(await MediaModel.countDocuments({ status: "uploading" })).toBe(2);
  });

  it.each([
    ["an unsupported type", [{ mimeType: "image/gif", size: 10 }]],
    ["a non-image type", [{ mimeType: "application/pdf", size: 10 }]],
    ["a zero size", [{ mimeType: "image/png", size: 0 }]],
    ["a negative size", [{ mimeType: "image/png", size: -5 }]],
    ["a size over 8 MB", [{ mimeType: "image/png", size: 8 * 1024 * 1024 + 1 }]],
    ["no files", []],
    ["more than 8 files", Array.from({ length: 9 }, () => ({ mimeType: "image/png", size: 10 }))],
  ])("rejects %s", async (_label, files) => {
    await requestTickets("user_a", files).expect(400);
    expect(await MediaModel.countDocuments()).toBe(0);
    expect((await accountState("primary")).usedBytes).toBe(0);
  });

  it("returns 507 and keeps nothing when no storage has room", async () => {
    await StorageAccountModel.updateMany({}, { status: "disabled" });
    await requestTickets("user_a", [png()]).expect(507);
    expect(await MediaModel.countDocuments()).toBe(0);
  });

  it("fails over to a bigger account when the first cannot fit the file", async () => {
    await StorageAccountModel.deleteMany({});
    await addAccount("tiny", { priority: 1, capacityBytes: 100 });
    await addAccount("roomy", { priority: 2 });

    await requestTickets("user_a", [png(5000)]).expect(201);

    expect((await accountState("tiny")).usedBytes).toBe(0);
    expect((await accountState("roomy")).usedBytes).toBe(5000);
  });

  it("caps unfinished tickets per user so reservations cannot be hoarded", async () => {
    await requestTickets("user_a", Array(8).fill(png())).expect(201);
    await requestTickets("user_a", Array(8).fill(png())).expect(201); // 16 open: the limit
    await requestTickets("user_a", [png()]).expect(429);

    await requestTickets("user_b", [png()]).expect(201); // another user is unaffected
  });
});

describe("POST /api/media/:id/complete", () => {
  it("confirms an upload and exposes it as pending, with the real size and a public URL", async () => {
    const ticket = await startAndUpload(PNG);

    const res = await complete("user_a", ticket.id).expect(200);

    expect(res.body.data).toMatchObject({ id: ticket.id, status: "pending", mimeType: "image/png", size: PNG.length });
    expect(res.body.data.url).toContain(ticket.upload.fields.key);
    expect((await accountState("primary")).usedBytes).toBe(PNG.length);
  });

  it("gives back reserved space when the file is smaller than declared", async () => {
    const ticket = await startAndUpload(PNG, { declared: 100_000 });
    expect((await accountState("primary")).usedBytes).toBe(100_000);

    await complete("user_a", ticket.id).expect(200);

    expect((await accountState("primary")).usedBytes).toBe(PNG.length);
  });

  it("returns 409 while the file has not arrived, and works once it has", async () => {
    const res = await requestTickets("user_a", [png()]).expect(201);
    const { id, upload } = res.body.data[0] as Ticket;

    await complete("user_a", id).expect(409);
    expect((await MediaModel.findById(id))!.status).toBe("uploading");

    (await providerOf("primary")).simulateClientUpload(upload.fields.key, PNG, "image/png");
    await complete("user_a", id).expect(200);
  });

  it("rejects, deletes and refunds a file bigger than it was declared to be", async () => {
    const provider = await providerOf("primary");
    const ticket = await startAndUpload(pngOfSize(5000), { declared: 100 });

    const res = await complete("user_a", ticket.id).expect(400);

    expect(res.body.message).toContain("does not match");
    expect(provider.objects.has(ticket.upload.fields.key)).toBe(false);
    expect(await MediaModel.countDocuments()).toBe(0);
    expect((await accountState("primary")).usedBytes).toBe(0);
  });

  it("rejects, deletes and refunds a file of a type that was not allowed", async () => {
    const provider = await providerOf("primary");
    const ticket = await startAndUpload(GIF, { declared: GIF.length, mimeType: "image/gif" });

    await complete("user_a", ticket.id).expect(400);

    expect(provider.objects.has(ticket.upload.fields.key)).toBe(false);
    expect(await MediaModel.countDocuments()).toBe(0);
    expect((await accountState("primary")).usedBytes).toBe(0);
  });

  it("is idempotent: completing twice returns the same media and charges once", async () => {
    const ticket = await startAndUpload(PNG);

    const first = await complete("user_a", ticket.id).expect(200);
    const second = await complete("user_a", ticket.id).expect(200);

    expect(second.body.data).toEqual(first.body.data);
    expect((await accountState("primary")).usedBytes).toBe(PNG.length);
  });

  it("handles simultaneous completes without double refunds", async () => {
    const ticket = await startAndUpload(PNG, { declared: 10_000 });

    const results = await Promise.all(Array.from({ length: 5 }, () => complete("user_a", ticket.id)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await accountState("primary")).usedBytes).toBe(PNG.length);
  });

  it("hides other people's uploads behind a 404 and requires sign-in", async () => {
    const ticket = await startAndUpload(PNG);
    await complete("user_b", ticket.id).expect(404);
    await request(app).post(`/api/media/${ticket.id}/complete`).expect(401);
    await complete("user_a", "000000000000000000000000").expect(404);
    expect((await MediaModel.findById(ticket.id))!.status).toBe("uploading");
  });

  it("produces media that posts can claim and that the normal delete rules protect", async () => {
    const ticket = await startAndUpload(PNG);
    await complete("user_a", ticket.id).expect(200);

    await getMediaService().attach(await userId("user_a"), [ticket.id]);

    await request(app).delete(`/api/media/${ticket.id}`).set(as("user_a")).expect(409);
  });
});

describe("abandoned direct uploads", () => {
  it("lets the owner cancel a ticket, refunding the reservation", async () => {
    const ticket = await startAndUpload(PNG, { declared: 5000 });

    await request(app).delete(`/api/media/${ticket.id}`).set(as("user_a")).expect(204);

    expect(await MediaModel.countDocuments()).toBe(0);
    expect((await accountState("primary")).usedBytes).toBe(0);
  });

  it("cleanup removes tickets never completed, but only after the ticket can no longer be used", async () => {
    const abandoned = await startAndUpload(PNG, { declared: 5000 });
    const recent = await startAndUpload(PNG, { declared: 3000 });
    const provider = await providerOf("primary");

    // createdAt is immutable in Mongoose, so backdate through the raw driver.
    await MediaModel.collection.updateOne(
      { _id: new Types.ObjectId(abandoned.id) },
      { $set: { createdAt: new Date(Date.now() - 66 * 60 * 1000) } },
    );
    await MediaModel.collection.updateOne(
      { _id: new Types.ObjectId(recent.id) },
      { $set: { createdAt: new Date(Date.now() - 30 * 60 * 1000) } },
    );

    expect(await getMediaService().cleanupExpired()).toBe(1);

    expect(await MediaModel.findById(abandoned.id)).toBeNull();
    expect(await MediaModel.findById(recent.id)).not.toBeNull();
    expect(provider.objects.has(abandoned.upload.fields.key)).toBe(false);
    expect((await accountState("primary")).usedBytes).toBe(3000);
  });
});
