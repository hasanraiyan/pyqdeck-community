import { Router } from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageModerator } from "../../src/modules/media/media.types.js";
import { addClerkUser, as, clerkUsers } from "../helpers/clerk.js";
import { seedCommunity } from "../helpers/community.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";
import { PNG, WEBP } from "../helpers/images.js";
import { providerOf } from "../helpers/storage.js";

vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);

const { createApp } = await import("../../src/app.js");
const { ImageValidator } = await import("../../src/modules/media/image-validator.js");
const { MediaModel } = await import("../../src/modules/media/media.model.js");
const { MediaRepository } = await import("../../src/modules/media/media.repository.js");
const { createMediaRoutes } = await import("../../src/modules/media/media.routes.js");
const { MediaService } = await import("../../src/modules/media/media.service.js");
const { StorageAccountModel } = await import("../../src/modules/storage/storage-account.model.js");
const { getStorageAdminService, getStorageService } = await import("../../src/modules/storage/storage.module.js");
const { createResolveCommunity } = await import("../../src/modules/communities/community.middleware.js");
const { attachMember } = await import("../../src/modules/auth/auth.middleware.js");
const { MemberModel } = await import("../../src/modules/members/member.model.js");

type Verdict = { allowed: boolean; unavailable: boolean; escalate?: boolean };
const ALLOW: Verdict = { allowed: true, unavailable: false };
const BLOCK: Verdict = { allowed: false, unavailable: false };
const DOWN: Verdict = { allowed: false, unavailable: true };

/** A moderator whose answers each test controls. */
const check = vi.fn<ImageModerator["check"]>();
const moderator: ImageModerator = { check };

const service = new MediaService(new MediaRepository(), getStorageService(), new ImageValidator(), moderator);
const router = Router();
const community = Router({ mergeParams: true });
community.use(createResolveCommunity(), attachMember);
community.use("/media", createMediaRoutes(service));
router.use("/v1/communities/:community", community);
const app = createApp(router);

const accountUsed = async () => (await StorageAccountModel.findOne({ name: "primary" }))!.usedBytes;

const uploadMultipart = (...files: Buffer[]) => {
  let req = request(app).post("/api/v1/communities/beu/media").set(as("user_a"));
  for (const f of files) req = req.attach("files", f, { filename: "photo.png" });
  return req;
};

type Ticket = { id: string; upload: { fields: Record<string, string> } };
const startDirect = async (data: Buffer) => {
  const res = await request(app)
    .post("/api/v1/communities/beu/media/uploads")
    .set(as("user_a"))
    .send({ files: [{ mimeType: "image/png", size: data.length }] })
    .expect(201);
  const ticket = res.body.data[0] as Ticket;
  (await providerOf("primary")).simulateClientUpload(ticket.upload.fields.key, data, "image/png");
  return ticket;
};
const complete = (id: string) => request(app).post(`/api/v1/communities/beu/media/${id}/complete`).set(as("user_a"));

beforeAll(async () => {
  await connectTestDb();
  await Promise.all([MemberModel.init(), StorageAccountModel.init(), MediaModel.init()]);
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seedCommunity();
  clerkUsers.clear();
  check.mockReset();
  check.mockResolvedValue(ALLOW);
  addClerkUser("user_a", { email: "alice@example.com" });
  await getStorageAdminService().add({
    name: "primary",
    provider: "memory",
    credentials: {},
    capacityBytes: 1024 ** 3,
  });
});

describe("multipart upload (bytes pass through the server)", () => {
  it("checks each image, with its real bytes and type, before storing it", async () => {
    await uploadMultipart(PNG, WEBP).expect(201);

    expect(check).toHaveBeenCalledTimes(2);
    const images = check.mock.calls.map(([image]) => image);
    expect(images).toEqual(
      expect.arrayContaining([
        { data: expect.any(Buffer), mimeType: "image/png" },
        { data: expect.any(Buffer), mimeType: "image/webp" },
      ]),
    );
    expect(check.mock.calls[0][1]).toMatchObject({ userId: expect.stringMatching(/^[0-9a-f]{24}$/) });
  });

  it("refuses a rejected image with 422 and never stores it", async () => {
    check.mockResolvedValue(BLOCK);

    const res = await uploadMultipart(PNG).expect(422);

    expect(res.body.message).toContain("community guidelines");
    expect(await MediaModel.countDocuments()).toBe(0);
    expect(await accountUsed()).toBe(0);
    expect((await providerOf("primary")).objects.size).toBe(0);
  });

  it("stores nothing at all when just one image in the batch is rejected", async () => {
    check.mockResolvedValueOnce(ALLOW).mockResolvedValueOnce(BLOCK);

    await uploadMultipart(PNG, WEBP).expect(422);

    expect(await MediaModel.countDocuments()).toBe(0);
    expect((await providerOf("primary")).objects.size).toBe(0);
  });

  it("answers 503 (retry shortly) when moderation is down, instead of letting images through unchecked", async () => {
    check.mockResolvedValue(DOWN);

    const res = await uploadMultipart(PNG).expect(503);

    expect(res.body.message).toContain("try again");
    expect(await MediaModel.countDocuments()).toBe(0);
    expect(await accountUsed()).toBe(0);
  });

  it("does not spend a moderation call on a file that is not even an image", async () => {
    await uploadMultipart(Buffer.from("%PDF-1.4 not an image")).expect(400);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("direct upload (bytes go app -> provider)", () => {
  it("checks the stored image by URL, naming the media it belongs to", async () => {
    const ticket = await startDirect(PNG);

    await complete(ticket.id).expect(200);

    expect(check).toHaveBeenCalledTimes(1);
    const [image, context] = check.mock.calls[0];
    expect(image).toEqual({ url: expect.stringContaining(ticket.upload.fields.key) });
    expect(context).toMatchObject({ sourceId: ticket.id });
  });

  it("keeps a refused image for review, never usable, and cleanup deletes it after a week", async () => {
    const ticket = await startDirect(PNG);
    check.mockResolvedValue(BLOCK);

    const res = await complete(ticket.id).expect(422);

    expect(res.body.message).toContain("community guidelines");
    expect((await providerOf("primary")).objects.has(ticket.upload.fields.key)).toBe(true);
    expect(await MediaModel.findById(ticket.id)).toMatchObject({
      status: "rejected",
      url: expect.stringContaining(ticket.upload.fields.key),
    });

    // Confirming it again stays refused, and it never becomes usable.
    check.mockResolvedValue(ALLOW);
    await complete(ticket.id).expect(422);
    expect(await MediaModel.countDocuments({ status: "pending" })).toBe(0);

    // Too young to be removed; past the retention it is deleted and the space refunded.
    expect(await service.cleanupExpired()).toBe(0);
    await MediaModel.collection.updateOne(
      { _id: new Types.ObjectId(ticket.id) },
      { $set: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } },
    );
    expect(await service.cleanupExpired()).toBe(1);
    expect((await providerOf("primary")).objects.has(ticket.upload.fields.key)).toBe(false);
    expect(await MediaModel.countDocuments()).toBe(0);
    expect(await accountUsed()).toBe(0);
  });

  it("deletes a child-safety image at once, drops the record and refunds the space", async () => {
    const ticket = await startDirect(PNG);
    check.mockResolvedValue({ ...BLOCK, escalate: true });

    await complete(ticket.id).expect(422);

    expect((await providerOf("primary")).objects.has(ticket.upload.fields.key)).toBe(false);
    expect(await MediaModel.countDocuments()).toBe(0);
    expect(await accountUsed()).toBe(0);
  });

  it("keeps the upload when moderation is down, so the app can simply retry", async () => {
    const ticket = await startDirect(PNG);
    check.mockResolvedValue(DOWN);

    await complete(ticket.id).expect(503);

    expect((await MediaModel.findById(ticket.id))!.status).toBe("uploading");
    expect((await providerOf("primary")).objects.has(ticket.upload.fields.key)).toBe(true);

    check.mockResolvedValue(ALLOW);
    const retry = await complete(ticket.id).expect(200);
    expect(retry.body.data.status).toBe("pending");
  });

  it("never marks an image usable until it has passed", async () => {
    const ticket = await startDirect(PNG);
    check.mockResolvedValue(DOWN);

    await complete(ticket.id).expect(503);

    expect(await MediaModel.countDocuments({ status: "pending" })).toBe(0);
  });

  it("does not re-moderate an image that was already confirmed (idempotent complete)", async () => {
    const ticket = await startDirect(PNG);
    await complete(ticket.id).expect(200);
    await complete(ticket.id).expect(200);

    expect(check).toHaveBeenCalledTimes(1);
  });
});
