import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addClerkUser, clerkUsers } from "../helpers/clerk.js";
import { client } from "../helpers/client.js";
import { seedCommunity, setMemberRole } from "../helpers/community.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";

vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);
vi.mock("../../src/modules/moderation/moderation.module.js", async (orig) =>
  (await import("../helpers/fake-moderation.js")).withFakeModerator(await orig<object>()),
);

const { createApp } = await import("../../src/app.js");
const { PostModel } = await import("../../src/modules/posts/post.model.js");
const { CommentModel } = await import("../../src/modules/comments/comment.model.js");
const { MemberModel } = await import("../../src/modules/members/member.model.js");
const { ReactionModel } = await import("../../src/modules/reactions/reaction.model.js");
const { NotificationModel } = await import("../../src/modules/notifications/notification.model.js");
const { FollowModel } = await import("../../src/modules/social/social.model.js");

const api = client(createApp());
const alice = () => api("user_a");
const bob = () => api("user_b");
const cara = () => api("user_c");
const mod = () => api("user_mod");
const visitor = () => api();

const publish = async (who = alice(), body = "a post") => (await who.post("/posts", { body }).expect(201)).body.data;
const comment = async (who: ReturnType<typeof alice>, postId: string, body: string, parentId?: string) =>
  (await who.post(`/posts/${postId}/comments`, { body, parentId }).expect(201)).body.data;

beforeAll(async () => {
  await connectTestDb();
  await Promise.all([
    PostModel.init(),
    CommentModel.init(),
    ReactionModel.init(),
    FollowModel.init(),
    MemberModel.init(),
  ]);
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seedCommunity();
  await seedCommunity("gate");
  clerkUsers.clear();
  for (const [id, name] of [
    ["user_a", "alice"],
    ["user_b", "bob"],
    ["user_c", "cara"],
    ["user_mod", "modmod"],
  ]) {
    addClerkUser(id, { email: `${name}@example.com`, username: name });
    await api(id).get("/members/me").expect(200);
  }
  await setMemberRole("user_mod", "moderator");
});

describe("comments", () => {
  it("adds a comment, counts it and lists it oldest first with a cursor", async () => {
    const post = await publish();
    await comment(bob(), post.id, "first");
    await comment(cara(), post.id, "second");
    await comment(bob(), post.id, "third");

    expect((await visitor().get(`/posts/${post.id}`)).body.data.commentsCount).toBe(3);
    const p1 = (await visitor().get(`/posts/${post.id}/comments?limit=2`).expect(200)).body;
    expect(p1.data.map((c: { body: string }) => c.body)).toEqual(["first", "second"]);
    const p2 = (await visitor().get(`/posts/${post.id}/comments?limit=2&cursor=${p1.pagination.nextCursor}`)).body;
    expect(p2.data.map((c: { body: string }) => c.body)).toEqual(["third"]);
    expect(p2.pagination.hasMore).toBe(false);
  });

  it("validates the body and requires sign-in", async () => {
    const post = await publish();
    await bob().post(`/posts/${post.id}/comments`, { body: "  " }).expect(400);
    await bob()
      .post(`/posts/${post.id}/comments`, { body: "x".repeat(1001) })
      .expect(400);
    await visitor().post(`/posts/${post.id}/comments`, { body: "hi" }).expect(401);
  });

  it("flattens a reply to a reply under the thread root and remembers who it answers", async () => {
    const post = await publish();
    const root = await comment(bob(), post.id, "root");
    const reply = await comment(cara(), post.id, "reply to root", root.id);
    const nested = await comment(alice(), post.id, "reply to reply", reply.id);

    expect(reply).toMatchObject({ parentId: root.id, replyTo: { username: "bob" } });
    expect(nested).toMatchObject({ parentId: root.id, replyTo: { username: "cara" } });

    const top = (await visitor().get(`/posts/${post.id}/comments`)).body.data;
    expect(top).toHaveLength(1);
    expect(top[0].repliesCount).toBe(2);
    const replies = (await visitor().get(`/comments/${root.id}/replies`).expect(200)).body.data;
    expect(replies.map((r: { body: string }) => r.body)).toEqual(["reply to root", "reply to reply"]);
    expect((await visitor().get(`/posts/${post.id}`)).body.data.commentsCount).toBe(3);
  });

  it("refuses to reply to a comment on another post", async () => {
    const one = await publish(alice(), "one");
    const two = await publish(alice(), "two");
    const root = await comment(bob(), one.id, "root");
    await cara().post(`/posts/${two.id}/comments`, { body: "wrong place", parentId: root.id }).expect(404);
  });

  it("rejects a comment that moderation refuses and holds one that needs review", async () => {
    const post = await publish();
    await bob().post(`/posts/${post.id}/comments`, { body: "REJECTME" }).expect(422);
    const held = await comment(bob(), post.id, "HOLDME please");
    expect(held.status).toBe("pending");
    expect((await cara().get(`/posts/${post.id}/comments`)).body.data).toHaveLength(0);
    expect((await bob().get(`/posts/${post.id}/comments`)).body.data).toHaveLength(1);
    expect((await visitor().get(`/posts/${post.id}`)).body.data.commentsCount).toBe(0);

    await mod().post(`/comments/${held.id}/moderate`, { action: "approve" }).expect(200);
    expect((await cara().get(`/posts/${post.id}/comments`)).body.data).toHaveLength(1);
    expect((await visitor().get(`/posts/${post.id}`)).body.data.commentsCount).toBe(1);
  });

  it("lets the author edit a comment and marks it edited", async () => {
    const post = await publish();
    const c = await comment(bob(), post.id, "typo");
    const res = await bob().patch(`/comments/${c.id}`, { body: "fixed" }).expect(200);
    expect(res.body.data).toMatchObject({ body: "fixed" });
    expect(res.body.data.editedAt).not.toBeNull();
    await cara().patch(`/comments/${c.id}`, { body: "hijack" }).expect(404);
  });

  it("lets the author, the post author and a moderator delete, but nobody else", async () => {
    const post = await publish();
    const mine = await comment(bob(), post.id, "bob's");
    const other = await comment(cara(), post.id, "cara's");
    const third = await comment(cara(), post.id, "cara's again");

    await cara().del(`/comments/${mine.id}`).expect(404); // not theirs, not their post
    await bob().del(`/comments/${mine.id}`).expect(204); // author
    await alice().del(`/comments/${other.id}`).expect(204); // post author
    await mod().del(`/comments/${third.id}`).expect(204); // moderator
    expect((await visitor().get(`/posts/${post.id}`)).body.data.commentsCount).toBe(0);
    expect((await visitor().get(`/posts/${post.id}/comments`)).body.data).toHaveLength(0);
  });

  it("removes a thread's replies from view and from the count when its root is deleted", async () => {
    const post = await publish();
    const root = await comment(bob(), post.id, "root");
    await comment(cara(), post.id, "r1", root.id);
    await comment(alice(), post.id, "r2", root.id);
    expect((await visitor().get(`/posts/${post.id}`)).body.data.commentsCount).toBe(3);

    await bob().del(`/comments/${root.id}`).expect(204);
    expect((await visitor().get(`/posts/${post.id}`)).body.data.commentsCount).toBe(0);
    await visitor().get(`/comments/${root.id}/replies`).expect(404);
  });

  it("hides comments with their post and refuses new ones", async () => {
    const post = await publish();
    await comment(bob(), post.id, "hi");
    await alice().del(`/posts/${post.id}`).expect(204);
    await visitor().get(`/posts/${post.id}/comments`).expect(404);
    await bob().post(`/posts/${post.id}/comments`, { body: "late" }).expect(404);
  });

  it("is idempotent for a retried create", async () => {
    const post = await publish();
    const send = () => bob().post(`/posts/${post.id}/comments`, { body: "once" }).set("Idempotency-Key", "k1");
    const a = (await send().expect(201)).body.data;
    const b = (await send().expect(201)).body.data;
    expect(b.id).toBe(a.id);
    expect(await CommentModel.countDocuments()).toBe(1);
  });

  it("notifies the post author of a comment and the answered member of a reply, not themselves", async () => {
    const post = await publish();
    const root = await comment(bob(), post.id, "nice post");
    await comment(alice(), post.id, "thanks", root.id); // alice is both post author and answered? no: answers bob
    await comment(alice(), post.id, "my own comment on my post"); // never notifies herself

    const forAlice = (await alice().get("/notifications")).body.data;
    expect(forAlice.map((n: { type: string }) => n.type)).toEqual(["comment"]);
    const forBob = (await bob().get("/notifications")).body.data;
    expect(forBob.map((n: { type: string }) => n.type)).toEqual(["reply"]);
    expect(forBob[0].actor.username).toBe("alice");
  });
});

describe("likes and bookmarks", () => {
  it("likes once, is harmless to repeat, and unlikes", async () => {
    const post = await publish();
    const first = (await bob().put(`/posts/${post.id}/like`).expect(200)).body.data;
    expect(first).toMatchObject({ likesCount: 1, isLiked: true });
    expect((await bob().put(`/posts/${post.id}/like`).expect(200)).body.data.likesCount).toBe(1);
    expect((await bob().get(`/posts/${post.id}`)).body.data.isLiked).toBe(true);
    expect((await bob().del(`/posts/${post.id}/like`).expect(200)).body.data).toMatchObject({
      likesCount: 0,
      isLiked: false,
    });
    expect((await bob().del(`/posts/${post.id}/like`).expect(200)).body.data.likesCount).toBe(0); // never negative
  });

  it("holds at one like per member under concurrent requests", async () => {
    const post = await publish();
    const results = await Promise.all(Array.from({ length: 8 }, () => bob().put(`/posts/${post.id}/like`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await visitor().get(`/posts/${post.id}`)).body.data.likesCount).toBe(1);
    expect(await ReactionModel.countDocuments({ kind: "post_like" })).toBe(1);
  });

  it("counts likes received on the author's profile and aggregates the notification", async () => {
    const post = await publish();
    await bob().put(`/posts/${post.id}/like`).expect(200);
    await cara().put(`/posts/${post.id}/like`).expect(200);
    expect((await visitor().get("/members/alice")).body.data.upvotesCount).toBe(2);
    const notes = (await alice().get("/notifications")).body.data;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: "upvote", count: 2 });
    await alice().put(`/posts/${post.id}/like`).expect(200); // own like: no notification
    expect((await alice().get("/notifications")).body.data[0].count).toBe(2);
  });

  it("refuses to like a post that is not published", async () => {
    const held = await publish(alice(), "HOLDME");
    await alice().put(`/posts/${held.id}/like`).expect(409);
  });

  it("likes comments under the same rules", async () => {
    const post = await publish();
    const c = await comment(bob(), post.id, "great");
    await Promise.all([cara().put(`/comments/${c.id}/like`), cara().put(`/comments/${c.id}/like`)]);
    expect((await cara().get(`/posts/${post.id}/comments`)).body.data[0]).toMatchObject({
      likesCount: 1,
      isLiked: true,
    });
    await cara().del(`/comments/${c.id}/like`).expect(200);
    expect((await visitor().get(`/posts/${post.id}/comments`)).body.data[0].likesCount).toBe(0);
  });

  it("bookmarks privately and lists saved posts newest-saved first", async () => {
    const one = await publish(alice(), "one");
    const two = await publish(alice(), "two");
    await bob().put(`/posts/${one.id}/bookmark`).expect(200);
    await bob().put(`/posts/${two.id}/bookmark`).expect(200);
    expect((await bob().get("/members/me/bookmarks")).body.data.map((p: { body: string }) => p.body)).toEqual([
      "two",
      "one",
    ]);
    expect((await cara().get("/members/me/bookmarks")).body.data).toHaveLength(0);
    await visitor().get("/members/me/bookmarks").expect(401);
    expect((await bob().get(`/posts/${one.id}`)).body.data).toMatchObject({ isBookmarked: true, bookmarksCount: 1 });
  });

  it("requires sign-in", async () => {
    const post = await publish();
    await visitor().put(`/posts/${post.id}/like`).expect(401);
    await visitor().put(`/posts/${post.id}/bookmark`).expect(401);
  });
});

describe("following", () => {
  it("follows, counts both sides, is idempotent, and notifies once", async () => {
    await bob().put("/members/alice/follow").expect(200);
    await bob().put("/members/alice/follow").expect(200);
    const profile = (await bob().get("/members/alice")).body.data;
    expect(profile).toMatchObject({ followersCount: 1, isFollowing: true });
    expect((await bob().get("/members/me")).body.data.followingCount).toBe(1);
    expect(
      (await alice().get("/notifications")).body.data.filter((n: { type: string }) => n.type === "follow"),
    ).toHaveLength(1);

    await bob().del("/members/alice/follow").expect(200);
    await bob().del("/members/alice/follow").expect(200);
    expect((await visitor().get("/members/alice")).body.data.followersCount).toBe(0);
  });

  it("refuses to follow yourself or someone who does not exist", async () => {
    await alice().put("/members/alice/follow").expect(400);
    await alice().put("/members/nobody/follow").expect(404);
  });

  it("keeps counts right under concurrent follows", async () => {
    await Promise.all(Array.from({ length: 6 }, () => bob().put("/members/alice/follow")));
    expect((await visitor().get("/members/alice")).body.data.followersCount).toBe(1);
  });

  it("lists followers and following with a cursor", async () => {
    await bob().put("/members/alice/follow");
    await cara().put("/members/alice/follow");
    const res = (await visitor().get("/members/alice/followers?limit=1")).body;
    expect(res.data).toHaveLength(1);
    expect(res.pagination.hasMore).toBe(true);
    expect((await visitor().get("/members/bob/following")).body.data[0].username).toBe("alice");
  });
});

describe("blocking", () => {
  it("hides each member from the other, both ways, and removes follows", async () => {
    const post = await publish(alice(), "alice post");
    const bobPost = await publish(bob(), "bob post");
    await bob().put("/members/alice/follow");
    await alice().put("/members/bob/follow");

    await alice().put("/members/bob/block").expect(204);

    expect((await alice().get("/posts")).body.data.map((p: { body: string }) => p.body)).toEqual(["alice post"]);
    expect((await bob().get("/posts")).body.data.map((p: { body: string }) => p.body)).toEqual(["bob post"]);
    await bob().get(`/posts/${post.id}`).expect(404);
    await alice().get(`/posts/${bobPost.id}`).expect(404);
    await bob().get("/members/alice").expect(404);
    await alice().get("/members/bob").expect(404);
    await bob().put(`/posts/${post.id}/like`).expect(404);
    await bob().post(`/posts/${post.id}/comments`, { body: "hi" }).expect(404);
    await bob().put("/members/alice/follow").expect(404);
    expect(await FollowModel.countDocuments()).toBe(0);
    expect((await visitor().get("/members/alice")).body.data).toMatchObject({ followersCount: 0, followingCount: 0 });
    expect((await alice().get("/members/me/blocked")).body.data.map((m: { username: string }) => m.username)).toEqual([
      "bob",
    ]);

    await alice().del("/members/bob/block").expect(204);
    await bob().get(`/posts/${post.id}`).expect(200);
  });
});

describe("notifications", () => {
  it("lists, filters, counts, marks read and dismisses", async () => {
    const post = await publish();
    await bob().put(`/posts/${post.id}/like`);
    await comment(cara(), post.id, "hello");
    await bob().put("/members/alice/follow");

    expect((await alice().get("/notifications/unread-count")).body.data.count).toBe(3);
    expect((await alice().get("/notifications?type=comment")).body.data).toHaveLength(1);

    const list = (await alice().get("/notifications?unread=true")).body.data;
    await alice().patch(`/notifications/${list[0].id}`, { read: true }).expect(204);
    expect((await alice().get("/notifications/unread-count")).body.data.count).toBe(2);
    await alice().patch(`/notifications/${list[1].id}`, { dismissed: true }).expect(204);
    expect((await alice().get("/notifications")).body.data).toHaveLength(2);

    await alice().post("/notifications/read-all").expect(204);
    expect((await alice().get("/notifications/unread-count")).body.data.count).toBe(0);
  });

  it("is private to the recipient", async () => {
    const post = await publish();
    await bob().put(`/posts/${post.id}/like`);
    const id = (await alice().get("/notifications")).body.data[0].id;
    await bob().patch(`/notifications/${id}`, { read: true }).expect(404);
    expect((await bob().get("/notifications")).body.data).toHaveLength(0);
    await visitor().get("/notifications").expect(401);
  });

  it("removes notifications about a comment that was deleted", async () => {
    const post = await publish();
    const c = await comment(bob(), post.id, "oops");
    expect(await NotificationModel.countDocuments({ type: "comment" })).toBe(1);
    await bob().del(`/comments/${c.id}`).expect(204);
    expect(await NotificationModel.countDocuments({ type: "comment" })).toBe(0);
  });
});

describe("reports and moderation", () => {
  it("accepts a report, ignores a duplicate, and refuses reports of one's own content", async () => {
    const post = await publish();
    const body = { targetType: "post", targetId: post.id, reason: "spam" };
    expect((await bob().post("/reports", body).expect(201)).body.data).toMatchObject({
      received: true,
      duplicate: false,
    });
    expect((await bob().post("/reports", body).expect(201)).body.data).toMatchObject({ duplicate: true });
    await alice().post("/reports", body).expect(400);
    await visitor().post("/reports", body).expect(401);
    await bob()
      .post("/reports", { ...body, reason: "bogus" })
      .expect(400);
  });

  it("hides a post once three different people report it, and restores it when the reports are dismissed", async () => {
    addClerkUser("user_d", { email: "dan@example.com", username: "dan" });
    const post = await publish();
    for (const who of [bob(), cara(), api("user_d")]) {
      await who.post("/reports", { targetType: "post", targetId: post.id, reason: "spam" }).expect(201);
    }
    expect((await visitor().get("/posts")).body.data).toHaveLength(0);
    await visitor().get(`/posts/${post.id}`).expect(404);
    expect((await alice().get(`/posts/${post.id}`)).body.data).toMatchObject({
      status: "pending",
      heldReason: "reports",
    });

    const queue = (await mod().get("/reports").expect(200)).body.data;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ targetType: "post", targetId: post.id, count: 3, reasons: ["spam"] });
    expect(queue[0].preview).toMatchObject({ authorUsername: "alice", postId: post.id, status: "pending" });
    expect(JSON.stringify(queue)).not.toMatch(/reporter/i); // reporters stay anonymous

    await mod().post("/reports/resolve", { targetType: "post", targetId: post.id, outcome: "dismissed" }).expect(200);
    expect((await visitor().get("/posts")).body.data).toHaveLength(1);
    expect((await mod().get("/reports")).body.data).toHaveLength(0);
  });

  it("removes content when the moderator acts on the reports", async () => {
    const post = await publish();
    await bob().post("/reports", { targetType: "post", targetId: post.id, reason: "hate" }).expect(201);
    await mod()
      .post("/reports/resolve", { targetType: "post", targetId: post.id, outcome: "actioned", remove: true })
      .expect(200);
    await visitor().get(`/posts/${post.id}`).expect(404);
    expect((await alice().get(`/posts/${post.id}`)).body.data).toMatchObject({
      status: "rejected",
      removedReason: "hate",
    });
    await alice().patch(`/posts/${post.id}`, { body: "edit a removed post" }).expect(409);
  });

  it("reports comments and members, and keeps the moderator queue to staff", async () => {
    const post = await publish();
    const c = await comment(bob(), post.id, "rude");
    await cara().post("/reports", { targetType: "comment", targetId: c.id, reason: "harassment" }).expect(201);
    await cara().post("/reports", { targetType: "member", targetId: "bob", reason: "spam" }).expect(201);
    await cara().get("/reports").expect(403);
    expect((await mod().get("/reports")).body.data).toHaveLength(2);
  });

  it("gives moderators a queue of held posts and comments to approve or remove", async () => {
    const held = await publish(alice(), "HOLDME post");
    const hc = await comment(bob(), (await publish()).id, "HOLDME comment");
    expect((await mod().get("/posts/queue").expect(200)).body.data).toHaveLength(1);
    // staff see why it is held; the author of someone else's held post is not involved here
    expect((await mod().get("/posts/queue")).body.data[0]).toMatchObject({
      heldReason: "moderation",
      status: "pending",
    });
    expect((await mod().get("/comments/queue")).body.data[0]).toMatchObject({ heldReason: "moderation" });
    expect((await mod().get("/comments/queue").expect(200)).body.data).toHaveLength(1);
    await bob().get("/posts/queue").expect(403);

    await mod().post(`/posts/${held.id}/moderate`, { action: "approve" }).expect(200);
    await mod().post(`/comments/${hc.id}/moderate`, { action: "remove", reason: "spam" }).expect(200);
    expect((await mod().get("/posts/queue")).body.data).toHaveLength(0);
    expect((await visitor().get("/posts")).body.data.map((p: { body: string }) => p.body)).toContain("HOLDME post");
  });

  it("requires a reason to remove and refuses a second decision", async () => {
    const held = await publish(alice(), "HOLDME");
    await mod().post(`/posts/${held.id}/moderate`, { action: "remove" }).expect(400);
    await mod().post(`/posts/${held.id}/moderate`, { action: "remove", reason: "spam" }).expect(200);
    await mod().post(`/posts/${held.id}/moderate`, { action: "approve" }).expect(409);
  });

  it("suspends a member: their posts vanish, they cannot write, and unsuspending restores everything", async () => {
    const post = await publish(bob(), "bob writes");
    await bob().put("/members/alice/follow");
    await mod().put("/members/bob/suspend", { reason: "spam wave" }).expect(204);

    expect((await visitor().get("/posts")).body.data).toHaveLength(0);
    await visitor().get(`/posts/${post.id}`).expect(404);
    await bob().post("/posts", { body: "still here?" }).expect(403);
    await bob().get("/members/me").expect(403);

    await mod().del("/members/bob/suspend").expect(204);
    expect((await visitor().get("/posts")).body.data).toHaveLength(1);
    await bob().post("/posts", { body: "back" }).expect(201);
  });

  it("stops a moderator acting on a peer or an admin, and lets only admins change roles", async () => {
    await setMemberRole("user_c", "moderator");
    await mod().put("/members/cara/suspend", { reason: "no" }).expect(403);
    await mod().put("/members/modmod/suspend", { reason: "self" }).expect(400);
    await mod().put("/members/bob/role", { role: "moderator" }).expect(403);
    await setMemberRole("user_a", "admin");
    await alice().put("/members/bob/role", { role: "moderator" }).expect(200);
    await bob().get("/posts/queue").expect(200);
  });
});

describe("account deletion", () => {
  it("hides everything the person posted and removes their profile", async () => {
    const mocks = await import("../helpers/clerk.js");
    void mocks;
    const post = await publish(bob(), "bob's words");
    await comment(cara(), post.id, "reply to bob");
    const { getAccountService } = await import("../../src/modules/accounts/account.module.js");
    const { getServices } = await import("../../src/composition.js");
    getServices();
    await getAccountService().markDeleted("user_b");

    await visitor().get(`/posts/${post.id}`).expect(404);
    expect((await visitor().get("/posts")).body.data).toHaveLength(0);
    await visitor().get("/members/bob").expect(404);
    expect(await PostModel.findById(post.id)).toMatchObject({ status: "deleted", deletedBy: "account" });
    await bob().get("/members/me").expect(401);
  });
});

describe("communities never leak into each other", () => {
  it("keeps posts, comments, counts, search, trending, notifications and profiles separate", async () => {
    const beuPost = await publish(alice(), "only in beu #secret");
    await comment(bob(), beuPost.id, "beu comment");
    await bob().put(`/posts/${beuPost.id}/like`);

    const gateAlice = api("user_a", "gate");
    const gatePost = (await gateAlice.post("/posts", { body: "only in gate #other" }).expect(201)).body.data;

    // reading
    await api(undefined, "gate").get(`/posts/${beuPost.id}`).expect(404);
    await api(undefined, "gate").get(`/posts/${beuPost.slug}`).expect(404);
    await api(undefined, "beu").get(`/posts/${gatePost.id}`).expect(404);
    expect((await api(undefined, "gate").get("/posts")).body.data.map((p: { id: string }) => p.id)).toEqual([
      gatePost.id,
    ]);
    expect((await api(undefined, "gate").get("/posts?q=secret")).body.data).toHaveLength(0);
    expect((await api(undefined, "gate").get("/posts?hashtag=secret")).body.data).toHaveLength(0);
    expect(
      (await api(undefined, "gate").get("/hashtags/trending")).body.data.map((t: { tag: string }) => t.tag),
    ).toEqual(["other"]);

    // writing
    await api("user_b", "gate").put(`/posts/${beuPost.id}/like`).expect(404);
    await api("user_b", "gate").post(`/posts/${beuPost.id}/comments`, { body: "cross" }).expect(404);
    await api("user_a", "gate").patch(`/posts/${beuPost.id}`, { body: "cross edit" }).expect(404);
    await api("user_a", "gate").del(`/posts/${beuPost.id}`).expect(404);
    await api("user_b", "gate")
      .post("/reports", { targetType: "post", targetId: beuPost.id, reason: "spam" })
      .expect(404);

    // people and counters
    expect((await api(undefined, "gate").get("/members/alice")).body.data.postsCount).toBe(1);
    // bob only touched gate through requests that failed, so his persona there is a fresh, empty one
    expect((await api(undefined, "gate").get("/members/bob")).body.data).toMatchObject({
      postsCount: 0,
      upvotesCount: 0,
    });
    expect((await api("user_a", "gate").get("/notifications")).body.data).toHaveLength(0);
    expect((await alice().get("/notifications")).body.data.length).toBeGreaterThan(0);

    // staff of one community have no powers in another
    await api("user_mod", "gate").get("/posts/queue").expect(403);
  });
});
