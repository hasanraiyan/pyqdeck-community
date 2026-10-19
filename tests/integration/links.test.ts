import request from "supertest";
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
const { LinkModel } = await import("../../src/modules/links/link.model.js");
const { PostModel } = await import("../../src/modules/posts/post.model.js");
const { MemberModel } = await import("../../src/modules/members/member.model.js");

const app = createApp();
const api = client(app);
const alice = () => api("user_a");
const bob = () => api("user_b");
const mod = () => api("user_mod");
const visitor = () => api();

/** A request to the link host, the way a phone browser would make it. */
const go = (path: string) => request(app).get(path).set("Host", "go.pyqdeck.in").set("User-Agent", "Mozilla/5.0");

const publish = async (body: string, who = alice()) => (await who.post("/posts", { body }).expect(201)).body.data;
const codeOf = (post: { links: Array<{ code: string }> }, index = 0) => post.links[index].code;

beforeAll(async () => {
  await connectTestDb();
  await Promise.all([LinkModel.init(), PostModel.init(), MemberModel.init()]);
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seedCommunity();
  clerkUsers.clear();
  for (const [id, name] of [
    ["user_a", "alice"],
    ["user_b", "bob"],
    ["user_mod", "modmod"],
  ]) {
    addClerkUser(id, { email: `${name}@example.com`, username: name });
    await api(id).get("/members/me").expect(200);
  }
  await setMemberRole("user_mod", "moderator");
});

describe("rewriting links for readers", () => {
  it("shows a short link on the link host and keeps the author's original text", async () => {
    const post = await publish("Read https://example.com/very/long/path?x=1&y=2#frag please");
    const code = codeOf(post);
    expect(code).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(post.links).toEqual([{ code, shortUrl: `https://go.pyqdeck.in/${code}`, host: "example.com", clicks: 0 }]);

    const seen = (await bob().get(`/posts/${post.id}`)).body.data;
    expect(seen.body).toBe(`Read https://go.pyqdeck.in/${code} please`);
    expect(seen.links[0]).not.toHaveProperty("clicks"); // click counts are for the author only
    expect(seen).not.toHaveProperty("rawBody");

    const mine = (await alice().get(`/posts/${post.id}`)).body.data;
    expect(mine.rawBody).toBe("Read https://example.com/very/long/path?x=1&y=2#frag please");
    expect((await PostModel.findById(post.id))!.body).toBe(mine.rawBody);
  });

  it("handles Markdown links and autolinks, and leaves code, math and the product's own URLs alone", async () => {
    const post = await publish(
      [
        "[notes](https://example.com/notes) and <https://example.org/a>",
        "`https://inline.example/code` and $x = https://math.example/y$",
        "```",
        "https://fenced.example/z",
        "```",
        "own link https://pyqdeck.in/community/abc and https://www.pyqdeck.in/x",
      ].join("\n"),
    );
    expect(post.links.map((l: { host: string }) => l.host)).toEqual(["example.com", "example.org"]);
    const code = codeOf(post);
    expect(post.body).toContain(`[notes](https://go.pyqdeck.in/${code})`);
    expect(post.body).toContain("`https://inline.example/code`");
    expect(post.body).toContain("$x = https://math.example/y$");
    expect(post.body).toContain("https://fenced.example/z");
    expect(post.body).toContain("https://pyqdeck.in/community/abc");
  });

  it("gives a separate link per URL, reuses it within a post, and keeps the code through edits", async () => {
    const post = await publish("one https://a.example/x and again https://a.example/x and two https://b.example/y");
    expect(post.links).toHaveLength(2);
    const [first, second] = post.links.map((l: { code: string }) => l.code);

    const edited = (await alice().patch(`/posts/${post.id}`, { body: "edited https://a.example/x only" }).expect(200))
      .body.data;
    expect(codeOf(edited)).toBe(first);
    const gone = await go(`/${second}`);
    expect(gone.status).toBe(410); // that URL left the post
  });

  it("normalises URLs so equivalent spellings share a link", async () => {
    const post = await publish("HTTPS://EXAMPLE.com:443/Path and https://example.com/Path");
    expect(post.links).toHaveLength(1);
    expect((await LinkModel.findOne({ code: codeOf(post) }))!.normalizedUrl).toBe("https://example.com/Path");
  });

  it("does not turn a URL fragment into a hashtag", async () => {
    const post = await publish("look https://example.com/page#section and #real");
    expect(post.hashtags).toEqual(["real"]);
  });

  it("works for comments and profile websites", async () => {
    const post = await publish("hello");
    const c = (await bob().post(`/posts/${post.id}/comments`, { body: "see https://example.com/c" }).expect(201)).body
      .data;
    expect(c.body).toMatch(/^see https:\/\/go\.pyqdeck\.in\/[A-Za-z0-9]{8}$/);
    expect(c.rawBody).toBe("see https://example.com/c");

    const me = (await bob().patch("/members/me", { website: "https://bob.example.com" }).expect(200)).body.data;
    expect(me.websiteLink).toMatchObject({ host: "bob.example.com" });
    expect(me.website).toBe("https://bob.example.com");
  });
});

describe("refusing unsafe or excessive links", () => {
  const refused = async (body: string, message: RegExp) => {
    const res = await alice().post("/posts", { body }).expect(422);
    expect(res.body.message).toMatch(message);
  };

  it("refuses dangerous schemes in Markdown links", async () => {
    await refused("[x](javascript:alert(1))", /javascript/);
    await refused("[x](data:text/html;base64,AAAA)", /data/);
    await refused("<file:///etc/passwd>", /file/);
    await refused("[x](intent://scan/#Intent;scheme=zxing;end)", /intent/);
  });

  it("refuses credentials, private addresses, loopback and bare hosts", async () => {
    await refused("https://user:pass@example.com/", /username or password/);
    for (const url of [
      "http://localhost/x",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest",
      "http://[::1]/",
      "http://2130706433/",
      "http://intranet/",
    ]) {
      await refused(`go to ${url}`, /internal or private/);
    }
  });

  it("refuses over-long URLs", async () => {
    await refused(`https://example.com/${"a".repeat(2100)}`, /too long/);
  });

  it("refuses URL shorteners, which hide the destination", async () => {
    await refused("https://bit.ly/abc123", /not allowed/);
    await refused("https://sub.tinyurl.com/x", /not allowed/);
  });

  it("limits distinct links per post and per comment", async () => {
    const six = Array.from({ length: 6 }, (_, i) => `https://s${i}.example.com/`).join(" ");
    await refused(six, /At most 5/);
    const post = await publish("fine");
    const four = Array.from({ length: 4 }, (_, i) => `https://s${i}.example.com/`).join(" ");
    await bob().post(`/posts/${post.id}/comments`, { body: four }).expect(422);
  });

  it("stores nothing when a link is refused", async () => {
    await alice().post("/posts", { body: "ok https://good.example.com/ and https://bit.ly/x" }).expect(422);
    expect(await LinkModel.countDocuments()).toBe(0);
    expect(await PostModel.countDocuments()).toBe(0);
  });

  it("refuses a link whose domain a moderator blocked, and stops existing ones from redirecting", async () => {
    const before = await publish("https://later-blocked.example/page");
    await mod().post("/links/blocked-domains/list", { domain: "later-blocked.example", reason: "piracy" }).expect(201);

    await alice().post("/posts", { body: "https://later-blocked.example/other" }).expect(422);
    expect((await go(`/${codeOf(before)}`)).status).toBe(403);

    await mod().del("/links/blocked-domains/list/later-blocked.example").expect(204);
    expect((await go(`/${codeOf(before)}`)).status).toBe(302);
  });

  it("lets only moderators manage blocked domains", async () => {
    await bob().post("/links/blocked-domains/list", { domain: "x.example", reason: "" }).expect(403);
    await visitor().get("/links/blocked-domains/list").expect(401);
  });
});

describe("the link host", () => {
  it("redirects a clean link straight to the stored destination, uncached and unindexed, and counts the click", async () => {
    const post = await publish("https://example.com/target?a=1");
    const res = await go(`/${codeOf(post)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://example.com/target?a=1");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toMatch(/noindex/);
    await vi.waitFor(async () => {
      expect((await alice().get(`/posts/${post.id}`)).body.data.links[0].clicks).toBe(1);
    });
  });

  it("does not count crawlers and link previews", async () => {
    const post = await publish("https://example.com/target");
    await request(app)
      .get(`/${codeOf(post)}`)
      .set("Host", "go.pyqdeck.in")
      .set("User-Agent", "WhatsApp/2.23 preview")
      .expect(302);
    await new Promise((r) => setTimeout(r, 100));
    expect((await alice().get(`/posts/${post.id}`)).body.data.links[0].clicks).toBe(0);
  });

  it("shows a warning page, not a redirect, for a lookalike host, and only Continue goes on", async () => {
    const post = await publish("https://xn--pple-43d.com/login");
    const code = codeOf(post);
    const page = await go(`/${code}`);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/html/);
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(page.text).toContain("xn--pple-43d.com");
    expect(page.text).toContain(`/${code}/go`);
    expect(page.headers.location).toBeUndefined();

    const cont = await go(`/${code}/go`);
    expect(cont.status).toBe(302);
    expect(cont.headers.location).toBe("https://xn--pple-43d.com/login");
  });

  it("warns for a host that looks suspicious", async () => {
    const post = await publish("http://203.0.113.9/free-gift");
    expect((await go(`/${codeOf(post)}`)).status).toBe(200);
  });

  it("answers 410 once the post is gone, 404 for unknown codes, and never redirects from a guessed code", async () => {
    const post = await publish("https://example.com/target");
    const code = codeOf(post);
    await alice().del(`/posts/${post.id}`).expect(204);
    expect((await go(`/${code}`)).status).toBe(410);
    expect((await go(`/${code}/go`)).status).toBe(410);
    expect((await go("/ZZZZZZZZ")).status).toBe(404);
    const traversal = await go("/ZZZZZZZZ?url=https://evil.example");
    expect(traversal.status).toBe(404);
    expect(traversal.headers.location).toBeUndefined();
  });

  it("deactivates the link of a held post and reactivates it on approval", async () => {
    const post = await publish("HOLDME https://example.com/held");
    expect(post.status).toBe("pending");
    expect((await go(`/${codeOf(post)}`)).status).toBe(410);
    await mod().post(`/posts/${post.id}/moderate`, { action: "approve" }).expect(200);
    expect((await go(`/${codeOf(post)}`)).status).toBe(302);
  });

  it("lets a moderator block one link", async () => {
    const post = await publish("https://example.com/one");
    await mod()
      .post(`/links/${codeOf(post)}/block`)
      .expect(204);
    expect((await go(`/${codeOf(post)}`)).status).toBe(403);
    await mod()
      .del(`/links/${codeOf(post)}/block`)
      .expect(204);
    expect((await go(`/${codeOf(post)}`)).status).toBe(410); // unblocked links wait for their content to re-activate them
  });

  it("serves only redirects there, and no short links on the API host", async () => {
    const post = await publish("https://example.com/target");
    expect((await go("/api/health")).status).toBe(404);
    expect((await go("/api/v1/communities/beu/posts")).status).toBe(404);
    const onApiHost = await request(app).get(`/${codeOf(post)}`);
    expect(onApiHost.status).toBe(404);
  });

  it("describes a link to the app without revealing the full destination", async () => {
    const post = await publish("https://example.com/secret/path?token=1");
    const res = (
      await visitor()
        .get(`/links/${codeOf(post)}`)
        .expect(200)
    ).body.data;
    expect(res).toMatchObject({ host: "example.com", verdict: "clean", status: "active", decision: "redirect" });
    expect(JSON.stringify(res)).not.toContain("token");
  });
});
