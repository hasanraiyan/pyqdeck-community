import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addClerkUser, as, clerkUsers } from "../helpers/clerk.js";
import { client } from "../helpers/client.js";
import { seedCommunity, setMemberRole } from "../helpers/community.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";
import { PNG } from "../helpers/images.js";

vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);
vi.mock("../../src/modules/moderation/moderation.module.js", async (orig) =>
  (await import("../helpers/fake-moderation.js")).withFakeModerator(await orig<object>()),
);

const { createApp } = await import("../../src/app.js");
const { PostModel } = await import("../../src/modules/posts/post.model.js");
const { MemberModel } = await import("../../src/modules/members/member.model.js");
const { MediaModel } = await import("../../src/modules/media/media.model.js");
const { NotificationModel } = await import("../../src/modules/notifications/notification.model.js");
const { StorageAccountModel } = await import("../../src/modules/storage/storage-account.model.js");
const { getStorageAdminService } = await import("../../src/modules/storage/storage.module.js");

const app = createApp();
const api = client(app);
const alice = () => api("user_a");
const bob = () => api("user_b");
const mod = () => api("user_mod");
const visitor = () => api();

const publish = async (who = alice(), body = "hello world", extra: object = {}) =>
  (await who.post("/posts", { body, ...extra }).expect(201)).body.data;

beforeAll(async () => {
  await connectTestDb();
  await Promise.all([PostModel.init(), MemberModel.init(), MediaModel.init(), StorageAccountModel.init()]);
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seedCommunity();
  clerkUsers.clear();
  addClerkUser("user_a", { email: "alice@example.com", username: "alice" });
  addClerkUser("user_b", { email: "bob@example.com", username: "bob" });
  addClerkUser("user_c", { email: "cara@example.com", username: "cara" });
  addClerkUser("user_mod", { email: "mod@example.com", username: "modmod" });
  for (const u of ["user_a", "user_b", "user_c", "user_mod"]) await api(u).get("/members/me").expect(200);
  await setMemberRole("user_mod", "moderator");
});

describe("creating posts", () => {
  it("publishes a text post and returns the author, counts and viewer flags", async () => {
    const res = await alice().post("/posts", { body: "Dijkstra explained #Algorithms" }).expect(201);
    expect(res.body.data).toMatchObject({
      status: "published",
      hashtags: ["Algorithms"],
      likesCount: 0,
      commentsCount: 0,
      isLiked: false,
      isBookmarked: false,
      isOwnPost: true,
      author: { username: "alice" },
    });
    expect(res.body.data.slug).toMatch(/^dijkstra-explained-algorithms-[0-9a-f]{6}$/);
    expect((await visitor().get("/members/alice").expect(200)).body.data.postsCount).toBe(1);
  });

  it("rejects empty and over-long posts, naming the problem", async () => {
    await alice().post("/posts", { body: "   " }).expect(400);
    await alice().post("/posts", {}).expect(400);
    const long = await alice()
      .post("/posts", { body: "x".repeat(5001) })
      .expect(400);
    expect(long.body.message).toMatch(/5000/);
  });

  it("requires sign-in", async () => {
    await visitor().post("/posts", { body: "hi" }).expect(401);
  });

  it("extracts hashtags case-insensitively, keeping the first spelling and ignoring URL fragments", async () => {
    const post = await publish(alice(), "#Maths and #maths again #Physics see https://example.com/page#section");
    expect(post.hashtags).toEqual(["Maths", "Physics"]);
  });

  it("keeps at most ten hashtags", async () => {
    const tags = Array.from({ length: 14 }, (_, i) => `#t${i}`).join(" ");
    expect((await publish(alice(), tags)).hashtags).toHaveLength(10);
  });

  it("stores an optional linked resource", async () => {
    const post = await publish(alice(), "see this", {
      linkedResource: { type: "pyq", title: "Data Structures 2023", subjectId: "ds", year: 2023 },
    });
    expect(post.linkedResource).toMatchObject({ type: "pyq", title: "Data Structures 2023", year: 2023 });
  });

  it("is idempotent for a retried request with the same Idempotency-Key", async () => {
    const send = () => alice().post("/posts", { body: "once only" }).set("Idempotency-Key", "key-123");
    const first = (await send().expect(201)).body.data;
    const second = (await send().expect(201)).body.data;
    expect(second.id).toBe(first.id);
    expect(await PostModel.countDocuments()).toBe(1);
  });

  it("does not hand back, or re-create, a post that was deleted before the retry arrived", async () => {
    const send = () => alice().post("/posts", { body: "gone soon" }).set("Idempotency-Key", "key-del");
    const first = (await send().expect(201)).body.data;
    await alice().del(`/posts/${first.id}`).expect(204);

    await send().expect(409);
    expect(await PostModel.countDocuments()).toBe(1);
    expect(await PostModel.countDocuments({ status: "published" })).toBe(0);
  });
});

describe("moderation of new posts", () => {
  it("refuses a rejected post with 422 and stores nothing", async () => {
    const res = await alice().post("/posts", { body: "REJECTME now" }).expect(422);
    expect(res.body.message).toMatch(/guidelines/);
    expect(await PostModel.countDocuments()).toBe(0);
  });

  it("holds a post that needs review: only the author sees it, and is told why", async () => {
    const post = await publish(alice(), "HOLDME please");
    expect(post).toMatchObject({ status: "pending", heldReason: "moderation" });

    expect((await visitor().get("/posts").expect(200)).body.data).toHaveLength(0);
    expect((await bob().get("/posts").expect(200)).body.data).toHaveLength(0);
    expect((await alice().get("/posts").expect(200)).body.data).toHaveLength(1);
    await bob().get(`/posts/${post.id}`).expect(404);
    await alice().get(`/posts/${post.id}`).expect(200);
    expect(await NotificationModel.countDocuments({ type: "moderation" })).toBe(1);
    expect((await visitor().get("/members/alice")).body.data.postsCount).toBe(0);
  });

  it("holds (never publishes) when the checker is unavailable", async () => {
    expect((await publish(alice(), "DOWNME")).status).toBe("pending");
  });
});

describe("reading posts", () => {
  it("lets visitors read the feed and a post by id or slug", async () => {
    const post = await publish();
    expect((await visitor().get("/posts").expect(200)).body.data).toHaveLength(1);
    expect((await visitor().get(`/posts/${post.id}`).expect(200)).body.data.id).toBe(post.id);
    expect((await visitor().get(`/posts/${post.slug}`).expect(200)).body.data.id).toBe(post.id);
  });

  it("pages with a cursor, newest first, without duplicates or gaps even when posts arrive meanwhile", async () => {
    for (let i = 1; i <= 5; i++) await publish(alice(), `post number ${i}`);
    const p1 = (await visitor().get("/posts?limit=2").expect(200)).body;
    expect(p1.data.map((p: { body: string }) => p.body)).toEqual(["post number 5", "post number 4"]);
    expect(p1.pagination.hasMore).toBe(true);

    await publish(bob(), "arrives while scrolling");

    const p2 = (await visitor().get(`/posts?limit=2&cursor=${p1.pagination.nextCursor}`).expect(200)).body;
    expect(p2.data.map((p: { body: string }) => p.body)).toEqual(["post number 3", "post number 2"]);
    const p3 = (await visitor().get(`/posts?limit=2&cursor=${p2.pagination.nextCursor}`).expect(200)).body;
    expect(p3.data.map((p: { body: string }) => p.body)).toEqual(["post number 1"]);
    expect(p3.pagination).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("rejects a malformed cursor and an over-large limit", async () => {
    await visitor().get("/posts?cursor=garbage").expect(400);
    await visitor().get("/posts?limit=51").expect(400);
  });

  it("filters by hashtag, case-insensitively", async () => {
    await publish(alice(), "graphs #DSA");
    await publish(alice(), "waves #physics");
    const res = await visitor().get("/posts?hashtag=dsa").expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].body).toContain("graphs");
  });

  it("searches post text and validates the query", async () => {
    await publish(alice(), "Understanding Dijkstra shortest paths");
    await publish(alice(), "Thermodynamics notes");
    const res = await visitor().get("/posts?q=dijkstra").expect(200);
    expect(res.body.data).toHaveLength(1);
    await visitor().get("/posts?q=a").expect(400); // too short
    await visitor().get("/posts?q=%21%21%21").expect(400); // no letter or digit
    await visitor()
      .get(`/posts?q=${"x".repeat(101)}`)
      .expect(400);
  });

  it("returns trending hashtags by distinct published posts", async () => {
    await publish(alice(), "#dsa one");
    await publish(bob(), "#dsa two #os");
    await publish(bob(), "#dsa #dsa three");
    const res = await visitor().get("/hashtags/trending").expect(200);
    expect(res.body.data[0]).toEqual({ tag: "dsa", count: 3 });
    expect(res.body.data[1]).toEqual({ tag: "os", count: 1 });
  });

  it("lists a member's posts, and the author also sees their held ones", async () => {
    await publish(alice(), "visible");
    await publish(alice(), "HOLDME hidden");
    expect((await visitor().get("/members/alice/posts").expect(200)).body.data).toHaveLength(1);
    expect((await alice().get("/members/alice/posts").expect(200)).body.data).toHaveLength(2);
  });

  it("hides a post from the viewer's own feed only, and can undo it", async () => {
    const post = await publish(alice(), "not for bob");
    await bob().put(`/posts/${post.id}/hide`).expect(204);
    expect((await bob().get("/posts").expect(200)).body.data).toHaveLength(0);
    expect((await alice().get("/posts").expect(200)).body.data).toHaveLength(1);
    await bob().del(`/posts/${post.id}/hide`).expect(204);
    expect((await bob().get("/posts").expect(200)).body.data).toHaveLength(1);
  });

  it("returns 404 for unknown ids and slugs", async () => {
    await visitor().get("/posts/000000000000000000000000").expect(404);
    await visitor().get("/posts/no-such-slug").expect(404);
  });
});

describe("editing posts", () => {
  it("lets the author edit text and marks it edited", async () => {
    const post = await publish(alice(), "first draft");
    const res = await alice().patch(`/posts/${post.id}`, { body: "second draft #fixed" }).expect(200);
    expect(res.body.data).toMatchObject({ body: "second draft #fixed", hashtags: ["fixed"], hasPendingEdit: false });
    expect(res.body.data.editedAt).not.toBeNull();
    expect((await visitor().get("/posts?hashtag=fixed")).body.data).toHaveLength(1);
  });

  it("does nothing for an unchanged edit", async () => {
    const post = await publish(alice(), "same");
    const res = await alice().patch(`/posts/${post.id}`, { body: "same" }).expect(200);
    expect(res.body.data.editedAt).toBeNull();
  });

  it("keeps the old text live while a held edit waits, then swaps it in when a moderator approves", async () => {
    const post = await publish(alice(), "clean original");
    const edited = await alice().patch(`/posts/${post.id}`, { body: "HOLDME new text" }).expect(200);
    expect(edited.body.data).toMatchObject({ body: "clean original", hasPendingEdit: true });
    expect((await visitor().get(`/posts/${post.id}`)).body.data.body).toBe("clean original");

    await mod().post(`/posts/${post.id}/moderate`, { action: "approve" }).expect(200);
    const live = (await visitor().get(`/posts/${post.id}`)).body.data;
    expect(live.body).toBe("HOLDME new text");
  });

  it("discards a held edit when the moderator rejects it", async () => {
    const post = await publish(alice(), "clean original");
    await alice().patch(`/posts/${post.id}`, { body: "HOLDME new text" }).expect(200);
    await mod().post(`/posts/${post.id}/moderate`, { action: "reject_edit" }).expect(200);
    const mine = (await alice().get(`/posts/${post.id}`)).body.data;
    expect(mine).toMatchObject({ body: "clean original", hasPendingEdit: false });
  });

  it("refuses an edit that moderation rejects and leaves the post unchanged", async () => {
    const post = await publish(alice(), "fine");
    await alice().patch(`/posts/${post.id}`, { body: "REJECTME" }).expect(422);
    expect((await visitor().get(`/posts/${post.id}`)).body.data.body).toBe("fine");
  });

  it("lets a held post be fixed by its author and published when it now passes", async () => {
    const post = await publish(alice(), "HOLDME");
    expect(post.status).toBe("pending");
    const res = await alice().patch(`/posts/${post.id}`, { body: "all good now" }).expect(200);
    expect(res.body.data.status).toBe("published");
    expect((await visitor().get("/posts")).body.data).toHaveLength(1);
    expect((await visitor().get("/members/alice")).body.data.postsCount).toBe(1);
  });

  it("answers 404 when someone else tries to edit", async () => {
    const post = await publish();
    await bob().patch(`/posts/${post.id}`, { body: "hijack" }).expect(404);
    await visitor().patch(`/posts/${post.id}`, { body: "hijack" }).expect(401);
  });

  it("rejects an empty edit body", async () => {
    const post = await publish();
    await alice().patch(`/posts/${post.id}`, {}).expect(400);
    await alice().patch(`/posts/${post.id}`, { body: "" }).expect(400);
  });
});

describe("deleting posts", () => {
  it("removes the post from every view at once", async () => {
    const post = await publish(alice(), "going away #bye");
    await bob().put(`/posts/${post.id}/bookmark`).expect(200);
    await alice().del(`/posts/${post.id}`).expect(204);

    await visitor().get(`/posts/${post.id}`).expect(404);
    await visitor().get(`/posts/${post.slug}`).expect(404);
    expect((await visitor().get("/posts")).body.data).toHaveLength(0);
    expect((await visitor().get("/posts?hashtag=bye")).body.data).toHaveLength(0);
    expect((await visitor().get("/members/alice/posts")).body.data).toHaveLength(0);
    expect((await bob().get("/members/me/bookmarks")).body.data).toHaveLength(0);
    expect((await visitor().get("/members/alice")).body.data.postsCount).toBe(0);
    expect(await PostModel.findById(post.id)).toMatchObject({ status: "deleted", deletedBy: "author" });
  });

  it("answers 404 for someone else's post and for a second delete", async () => {
    const post = await publish();
    await bob().del(`/posts/${post.id}`).expect(404);
    await alice().del(`/posts/${post.id}`).expect(204);
    await alice().del(`/posts/${post.id}`).expect(404);
  });

  it("removes the notifications that point to the post", async () => {
    const post = await publish();
    await bob().put(`/posts/${post.id}/like`).expect(200);
    expect((await alice().get("/notifications/unread-count")).body.data.count).toBe(1);
    await alice().del(`/posts/${post.id}`).expect(204);
    expect((await alice().get("/notifications/unread-count")).body.data.count).toBe(0);
  });

  it("purges soft-deleted posts only after the 30 day window", async () => {
    const { getServices } = await import("../../src/composition.js");
    const post = await publish();
    await alice().del(`/posts/${post.id}`).expect(204);
    expect(await getServices().posts.purgeExpired()).toBe(0);
    await PostModel.updateOne({ _id: post.id }, { deletedAt: new Date(Date.now() - 31 * 86_400_000) });
    expect(await getServices().posts.purgeExpired()).toBe(1);
    expect(await PostModel.countDocuments()).toBe(0);
  });
});

describe("images on posts", () => {
  beforeEach(async () => {
    await getStorageAdminService().add({
      name: "primary",
      provider: "memory",
      credentials: {},
      capacityBytes: 1024 ** 3,
    });
  });

  const uploadImage = async (clerkId = "user_a") => {
    const res = await request(app)
      .post("/api/v1/communities/beu/media")
      .set(as(clerkId))
      .attach("files", PNG, { filename: "p.png" })
      .expect(201);
    return res.body.data[0].id as string;
  };

  it("attaches uploaded images, returns their URLs and frees them when the post is deleted", async () => {
    const id = await uploadImage();
    const post = await publish(alice(), "with image", { mediaIds: [id] });
    expect(post.media).toEqual([{ id, url: expect.stringMatching(/^memory:\/\//) }]);
    expect(await MediaModel.countDocuments({ status: "attached" })).toBe(1);

    await alice().del(`/posts/${post.id}`).expect(204);
    expect(await MediaModel.countDocuments()).toBe(0);
  });

  it("allows an image-only post but refuses someone else's upload", async () => {
    const id = await uploadImage();
    await bob()
      .post("/posts", { mediaIds: [id] })
      .expect(400);
    expect((await publish(alice(), "", { mediaIds: [id] })).media).toHaveLength(1);
  });

  it("replaces and removes images when editing, freeing the ones no longer used", async () => {
    const first = await uploadImage();
    const second = await uploadImage();
    const post = await publish(alice(), "pics", { mediaIds: [first] });
    const res = await alice()
      .patch(`/posts/${post.id}`, { mediaIds: [second] })
      .expect(200);
    expect(res.body.data.media.map((m: { id: string }) => m.id)).toEqual([second]);
    expect(await MediaModel.countDocuments()).toBe(1);
  });

  it("enforces the community image limit", async () => {
    const { CommunityModel } = await import("../../src/modules/communities/community.model.js");
    await CommunityModel.updateOne({ slug: "beu" }, { limits: { maxImagesPerPost: 1 } });
    const ids = [await uploadImage(), await uploadImage()];
    await alice().post("/posts", { body: "two", mediaIds: ids }).expect(400);
  });
});
