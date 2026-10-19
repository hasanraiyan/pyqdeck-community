import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addClerkUser, clerkUsers } from "../helpers/clerk.js";
import { client } from "../helpers/client.js";
import { seedCommunity } from "../helpers/community.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";

// No fake moderator here: this runs the real moderation module (with no OpenAI key the provider allows everything),
// so a refusal can only come from the local word filter.
vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);

const { createApp } = await import("../../src/app.js");
const { PostModel } = await import("../../src/modules/posts/post.model.js");
const { CommentModel } = await import("../../src/modules/comments/comment.model.js");
const { MemberModel } = await import("../../src/modules/members/member.model.js");
const { ModerationEventModel } = await import("../../src/modules/moderation/moderation-event.model.js");

const api = client(createApp());
const alice = () => api("user_a");

const BAD = "you are a fucking idiot";

beforeAll(async () => {
  await connectTestDb();
  await Promise.all([PostModel.init(), CommentModel.init(), MemberModel.init(), ModerationEventModel.init()]);
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seedCommunity();
  clerkUsers.clear();
  addClerkUser("user_a", { email: "alice@example.com", username: "alice" });
  await alice().get("/members/me").expect(200);
});

describe("the word filter on every kind of text", () => {
  it("refuses a post with bad language, says why in plain words, and stores nothing", async () => {
    const res = await alice().post("/posts", { body: BAD }).expect(422);
    expect(res.body.message).toMatch(/language that is not allowed/);
    expect(await PostModel.countDocuments()).toBe(0);
  });

  it("refuses a comment and an edit with bad language", async () => {
    const post = (await alice().post("/posts", { body: "a clean question about Dijkstra" }).expect(201)).body.data;
    await alice().post(`/posts/${post.id}/comments`, { body: BAD }).expect(422);
    const comment = (await alice().post(`/posts/${post.id}/comments`, { body: "clean comment" }).expect(201)).body.data;
    await alice().patch(`/comments/${comment.id}`, { body: BAD }).expect(422);
    await alice().patch(`/posts/${post.id}`, { body: BAD }).expect(422);
    expect((await alice().get(`/posts/${post.id}`)).body.data.body).toBe("a clean question about Dijkstra");
  });

  it("refuses bad language in profile text", async () => {
    const res = await alice().patch("/members/me", { bio: BAD }).expect(422);
    expect(res.body.message).toMatch(/language that is not allowed/);
  });

  it("lets normal study content through, including words that only look rude", async () => {
    await alice()
      .post("/posts", { body: "Sex ratio of the population, class assignment and the Scunthorpe problem" })
      .expect(201);
  });

  it("records the refusal without the words themselves", async () => {
    await alice().post("/posts", { body: BAD }).expect(422);
    const event = await ModerationEventModel.findOne().lean();
    expect(event).toMatchObject({
      source: "post",
      action: "reject",
      provider: "profanity-filter",
      categories: ["profanity"],
    });
    expect(JSON.stringify(event)).not.toMatch(/fuck|idiot/i);
  });
});
