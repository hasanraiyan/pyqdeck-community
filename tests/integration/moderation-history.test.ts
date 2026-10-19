import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addClerkUser, as, clerkUsers } from "../helpers/clerk.js";
import { client } from "../helpers/client.js";
import { BASE, seedCommunity, setMemberRole } from "../helpers/community.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";
import { PNG } from "../helpers/images.js";
import { providerOf } from "../helpers/storage.js";

// The real moderation module (no OpenAI key in tests, so its provider allows everything): every check must leave a
// record, allowed ones included.
vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);

const { createApp } = await import("../../src/app.js");
const { MediaModel } = await import("../../src/modules/media/media.model.js");
const { MemberModel } = await import("../../src/modules/members/member.model.js");
const { ModerationEventModel } = await import("../../src/modules/moderation/moderation-event.model.js");
const { StorageAccountModel } = await import("../../src/modules/storage/storage-account.model.js");
const { getStorageAdminService } = await import("../../src/modules/storage/storage.module.js");

const app = createApp();
const api = client(app);

const uploadAndConfirm = async (clerkId = "user_a") => {
  const res = await request(app)
    .post(`${BASE()}/media/uploads`)
    .set(as(clerkId))
    .send({ files: [{ mimeType: "image/png", size: PNG.length }] })
    .expect(201);
  const ticket = res.body.data[0] as { id: string; upload: { fields: Record<string, string> } };
  (await providerOf("primary")).simulateClientUpload(ticket.upload.fields.key, PNG, "image/png");
  await request(app).post(`${BASE()}/media/${ticket.id}/complete`).set(as(clerkId)).expect(200);
  return ticket.id;
};

beforeAll(async () => {
  await connectTestDb();
  await Promise.all([MediaModel.init(), MemberModel.init(), ModerationEventModel.init(), StorageAccountModel.init()]);
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seedCommunity();
  clerkUsers.clear();
  addClerkUser("user_a", { email: "alice@example.com", username: "alice" });
  addClerkUser("user_mod", { email: "mod@example.com", username: "modmod" });
  await api("user_a").get("/members/me").expect(200);
  await api("user_mod").get("/members/me").expect(200);
  await setMemberRole("user_mod", "moderator");
  await getStorageAdminService().add({
    name: "primary",
    provider: "memory",
    credentials: {},
    capacityBytes: 1024 ** 3,
  });
});

describe("moderation history", () => {
  it("keeps the result for every image that was checked, even when it was allowed", async () => {
    const mediaId = await uploadAndConfirm();

    const event = await ModerationEventModel.findOne({ sourceId: mediaId }).lean();
    expect(event).toMatchObject({ source: "media", action: "allow", degraded: false, sourceId: mediaId });
    expect(String(event!.userId)).toBe(String((await MemberModel.findOne({ username: "alice" }))!._id));
  });

  it("lets a moderator look up what the check said about one image, and filter allowed results", async () => {
    const first = await uploadAndConfirm();
    await uploadAndConfirm();

    const one = (await api("user_mod").get(`/moderation/events?sourceId=${first}`).expect(200)).body.data;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ action: "allow", source: "media", sourceId: first });

    const allowed = (await api("user_mod").get("/moderation/events?action=allow&source=media").expect(200)).body;
    expect(allowed.data).toHaveLength(2);
  });

  it("keeps the history private to staff of that community", async () => {
    const mediaId = await uploadAndConfirm();
    await api("user_a").get(`/moderation/events?sourceId=${mediaId}`).expect(403);
    await api().get(`/moderation/events?sourceId=${mediaId}`).expect(401);
  });
});
