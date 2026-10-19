import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCommunityClient,
  communityKeys,
  CommunityApiError,
  isAbortError,
  type FileUploader,
} from "../../sdk/src/index.js";
import { addClerkUser, clerkUsers } from "../helpers/clerk.js";
import { seedCommunity } from "../helpers/community.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";
import { PNG } from "../helpers/images.js";
import { providerOf } from "../helpers/storage.js";

vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);
vi.mock("../../src/modules/moderation/moderation.module.js", async (orig) =>
  (await import("../helpers/fake-moderation.js")).withFakeModerator(await orig<object>()),
);

const { createApp } = await import("../../src/app.js");
const { MediaModel } = await import("../../src/modules/media/media.model.js");
const { PostModel } = await import("../../src/modules/posts/post.model.js");
const { MemberModel } = await import("../../src/modules/members/member.model.js");
const { ReactionModel } = await import("../../src/modules/reactions/reaction.model.js");
const { StorageAccountModel } = await import("../../src/modules/storage/storage-account.model.js");
const { getStorageAdminService } = await import("../../src/modules/storage/storage.module.js");

let server: Server;
let baseUrl = "";

/** The test Clerk mock reads an `x-test-user` header; the SDK sends a Bearer token, so translate one into the other. */
const asClerk: typeof fetch = (url, init) => {
  const auth = new Headers(init?.headers).get("authorization");
  const headers = new Headers(init?.headers);
  if (auth) headers.set("x-test-user", auth.replace("Bearer ", ""));
  return fetch(url, { ...init, headers });
};

/** Stands in for the phone sending bytes straight to the storage provider. */
const fakeUploader: FileUploader = async ({ ticket, image, onProgress }) => {
  (await providerOf("primary")).simulateClientUpload(String(ticket.fields.key), PNG, image.mimeType);
  onProgress(image.size / 2, image.size);
  onProgress(image.size, image.size);
};

const sdk = (user: string | null, over: Partial<Parameters<typeof createCommunityClient>[0]> = {}) =>
  createCommunityClient({
    baseUrl,
    community: "beu",
    getToken: async () => user,
    fetch: asClerk,
    uploadFile: fakeUploader,
    ...over,
  });

const image = { uri: "file:///a.png", mimeType: "image/png" as const, size: PNG.length, name: "a.png" };

beforeAll(async () => {
  await connectTestDb();
  // Indexes are built asynchronously; the $text search and the unique constraints need them in place first.
  await Promise.all([
    MediaModel.init(),
    StorageAccountModel.init(),
    PostModel.init(),
    MemberModel.init(),
    ReactionModel.init(),
  ]);
  server = createApp().listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearTestDb();
  await seedCommunity();
  clerkUsers.clear();
  addClerkUser("user_a", { email: "alice@example.com", username: "alice" });
  addClerkUser("user_b", { email: "bob@example.com", username: "bob" });
  await getStorageAdminService().add({
    name: "primary",
    provider: "memory",
    credentials: {},
    capacityBytes: 1024 ** 3,
  });
});

describe("community SDK against the real server", () => {
  it("publishes a post with images in one call, reporting progress up to 1", async () => {
    const progress: number[] = [];
    const post = await sdk("user_a").publishPost({
      body: "notes #dsa https://example.com/x",
      images: [image, image],
      onProgress: (p) => progress.push(p),
    });
    expect(post).toMatchObject({ status: "published", hashtags: ["dsa"], isOwnPost: true });
    expect(post.media).toHaveLength(2);
    expect(post.body).toMatch(/^notes #dsa https:\/\/go\.pyqdeck\.in\/[A-Za-z0-9]{8}$/);
    expect(post.rawBody).toBe("notes #dsa https://example.com/x");
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b)); // never goes backwards
    expect(await MediaModel.countDocuments({ status: "attached" })).toBe(2);
  });

  it("publishes text only without touching storage", async () => {
    const post = await sdk("user_a").publishPost({ body: "just words" });
    expect(post.media).toEqual([]);
    expect(await MediaModel.countDocuments()).toBe(0);
  });

  it("removes the uploaded images again when the post is refused", async () => {
    const err = await sdk("user_a")
      .publishPost({ body: "REJECTME", images: [image] })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(CommunityApiError);
    expect(err).toMatchObject({ status: 422, code: "unprocessable_entity", isRefused: true });
    expect(await MediaModel.countDocuments()).toBe(0);
  });

  it("is safe to retry with the same idempotency key", async () => {
    const client = sdk("user_a");
    const a = await client.publishPost({ body: "once", idempotencyKey: "retry-1" });
    const b = await client.publishPost({ body: "once", idempotencyKey: "retry-1" });
    expect(b.id).toBe(a.id);
  });

  it("covers the app's feed, like, bookmark, comment and follow flows", async () => {
    const alice = sdk("user_a");
    const bob = sdk("user_b");
    const post = await alice.publishPost({ body: "hello community #hi" });

    const feed = await bob.posts.feed({ limit: 10 });
    expect(feed.items.map((p) => p.id)).toEqual([post.id]);
    expect(feed).toMatchObject({ hasMore: false, nextCursor: null });

    expect(await bob.posts.like(post.id)).toEqual({ likesCount: 1, isLiked: true });
    expect(await bob.posts.bookmark(post.id)).toEqual({ bookmarksCount: 1, isBookmarked: true });
    const root = await bob.comments.create(post.id, { body: "nice" });
    const reply = await alice.comments.create(post.id, { body: "thanks", parentId: root.id });
    expect(reply).toMatchObject({ parentId: root.id, replyTo: { username: "bob" } });

    const threads = await bob.comments.list(post.id);
    expect(threads.items).toHaveLength(1);
    expect(threads.items[0].repliesCount).toBe(1);
    expect((await bob.comments.replies(root.id)).items.map((c) => c.body)).toEqual(["thanks"]);

    expect(await bob.members.follow("alice")).toMatchObject({ isFollowing: true, followersCount: 1 });
    expect(await bob.notifications.unreadCount()).toBe(1); // alice's reply
    expect((await alice.notifications.list()).items.map((n) => n.type).sort()).toEqual(["comment", "follow", "upvote"]);
    await alice.notifications.markAllRead();
    expect(await alice.notifications.unreadCount()).toBe(0);

    expect((await alice.members.me()).postsCount).toBe(1);
    expect((await bob.members.get("alice")).isFollowing).toBe(true);
    expect((await bob.posts.bookmarks()).items.map((p) => p.id)).toEqual([post.id]);
    expect(await bob.posts.trending()).toEqual([{ tag: "hi", count: 1 }]);
    expect((await bob.posts.feed({ q: "hello" })).items).toHaveLength(1);
  });

  it("edits, reports and deletes", async () => {
    const alice = sdk("user_a");
    const post = await alice.publishPost({ body: "draft" });
    expect((await alice.posts.edit(post.id, { body: "final" })).body).toBe("final");
    expect(await sdk("user_b").reports.create({ targetType: "post", targetId: post.id, reason: "spam" })).toEqual({
      received: true,
      duplicate: false,
    });
    await alice.posts.delete(post.id);
    await expect(sdk(null).posts.get(post.id)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("explains failures with a status, a stable code and the request id", async () => {
    await expect(sdk(null).posts.create({ body: "anon" })).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      isUnauthorized: true,
    });
    const err = (await sdk("user_a")
      .posts.create({ mediaIds: ["not-an-id"] })
      .catch((e: unknown) => e)) as CommunityApiError;
    expect(err).toMatchObject({ status: 400, code: "bad_request" });
    expect(err.requestId).toBeTruthy();
    expect(err.details).toBeTruthy();
  });

  it("surfaces Retry-After on a rate-limited response", async () => {
    const limited = sdk("user_a", {
      fetch: async () =>
        new Response(JSON.stringify({ success: false, message: "Too many requests", code: "too_many_requests" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "7" },
        }),
    });
    await expect(limited.posts.feed()).rejects.toMatchObject({ status: 429, retryAfterMs: 7000, isRateLimited: true });
  });

  it("reports a dead network and a cancelled request differently", async () => {
    const offline = sdk("user_a", {
      fetch: async () => {
        throw new TypeError("Network request failed");
      },
    });
    await expect(offline.posts.feed()).rejects.toMatchObject({
      status: 0,
      code: "network_error",
      isNetworkError: true,
    });

    const controller = new AbortController();
    const slow = sdk("user_a", {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) return reject(new Error("aborted"));
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const pending = slow.posts.feed({}, { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    expect(isAbortError(await pending)).toBe(true);
  });

  it("times out instead of hanging", async () => {
    const hung = sdk("user_a", {
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) return reject(new Error("aborted"));
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await expect(hung.posts.feed()).rejects.toMatchObject({ status: 0, code: "timeout" });
  });

  it("returns only JSON-safe values, so responses can be persisted by the app", async () => {
    const alice = sdk("user_a");
    const post = await alice.publishPost({ body: "persist me" });
    const feed = await alice.posts.feed();
    expect(JSON.parse(JSON.stringify(feed))).toEqual(feed);
    expect(typeof post.createdAt).toBe("string");
  });

  it("builds cache keys that always carry the community", () => {
    expect(communityKeys.feed("beu", { hashtag: "dsa" })).toEqual(["community", "beu", "feed", { hashtag: "dsa" }]);
    expect(communityKeys.post("gate", "x")[1]).toBe("gate");
    expect(communityKeys.feed("beu")).not.toEqual(communityKeys.feed("gate"));
    for (const key of Object.values(communityKeys)) {
      const sample = (key as (c: string, a?: string) => readonly unknown[])("jee", "x");
      expect(sample.slice(0, 2)).toEqual(["community", "jee"]);
    }
  });

  it("is tied to one community", async () => {
    await seedCommunity("gate");
    const gate = sdk("user_a", { community: "gate" });
    expect((await gate.info()).slug).toBe("gate");
    const post = await sdk("user_a").publishPost({ body: "beu only" });
    await expect(gate.posts.get(post.id)).rejects.toMatchObject({ status: 404 });
  });
});
