import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addClerkUser, as, clerkUsers } from "../helpers/clerk.js";
import { client } from "../helpers/client.js";
import { seedCommunity } from "../helpers/community.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";

vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);

const { createApp } = await import("../../src/app.js");
const { CommunityModel } = await import("../../src/modules/communities/community.model.js");
const { getCommunityService } = await import("../../src/modules/communities/community.module.js");

const app = createApp();
const api = client(app);
const admin = () => request(app).get("/api/v1/admin/communities").set(as("user_admin"));
const send = (method: "post" | "patch" | "put", path: string, body: object, who = "user_admin") =>
  request(app)[method](`/api/v1/admin/communities${path}`).set(as(who)).send(body);

beforeAll(async () => {
  await connectTestDb();
  await CommunityModel.init();
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  clerkUsers.clear();
  addClerkUser("user_admin", { email: "boss@example.com" }); // allow-listed in vitest.config, so platform admin
  addClerkUser("user_member", { email: "member@example.com" });
});

describe("platform community management", () => {
  it("is closed to anonymous callers and members", async () => {
    await request(app).get("/api/v1/admin/communities").expect(401);
    await request(app).get("/api/v1/admin/communities").set(as("user_member")).expect(403);
    await send("post", "", { slug: "gate", name: "GATE" }, "user_member").expect(403);
  });

  it("creates a community at runtime and serves it straight away, without a redeploy", async () => {
    const res = await send("post", "", { slug: "GATE", name: "GATE Aspirants" }).expect(201);
    expect(res.body.data).toMatchObject({ slug: "gate", name: "GATE Aspirants", status: "active" });
    expect(res.body.data.limits).toMatchObject({ postMaxChars: 5000, maxImagesPerPost: 8 });
    expect((await api(undefined, "gate").get("/").expect(200)).body.data.slug).toBe("gate");
    expect((await admin().expect(200)).body.data).toHaveLength(1);
  });

  it("refuses duplicate and badly formed slugs", async () => {
    await send("post", "", { slug: "gate", name: "GATE" }).expect(201);
    await send("post", "", { slug: "gate", name: "again" }).expect(409);
    await send("post", "", { slug: "1bad", name: "x" }).expect(400);
    await send("post", "", { slug: "has space", name: "x" }).expect(400);
  });

  it("lowers limits per community but never above the platform ceiling", async () => {
    await send("post", "", { slug: "jee", name: "JEE", limits: { maxImagesPerPost: 3, postMaxChars: 2000 } }).expect(
      201,
    );
    expect((await api(undefined, "jee").get("/")).body.data.limits).toMatchObject({
      maxImagesPerPost: 3,
      postMaxChars: 2000,
    });
    await send("patch", "/jee", { limits: { maxImagesPerPost: 9 } }).expect(400);
    await send("patch", "/jee", { limits: { unknown: 1 } }).expect(400);
  });

  it("walks a community through active, read-only and disabled, refusing illegal moves", async () => {
    await seedCommunity("gate");
    expect((await send("put", "/gate/status", { status: "read_only" }).expect(200)).body.data.status).toBe("read_only");
    await send("put", "/gate/status", { status: "read_only" }).expect(409); // already there
    await send("put", "/gate/status", { status: "disabled" }).expect(200);
    await api(undefined, "gate").get("/").expect(404);
    await send("put", "/gate/status", { status: "read_only" }).expect(409); // disabled can only go back to active
    await send("put", "/gate/status", { status: "active" }).expect(200);
    await api(undefined, "gate").get("/").expect(200);
  });

  it("seeds default communities on boot without duplicating", async () => {
    await getCommunityService().ensureDefaults(["beu", "gate"]);
    await getCommunityService().ensureDefaults(["beu", "gate"]);
    expect(await CommunityModel.countDocuments()).toBe(2);
  });
});

describe("platform-wide blocked domains", () => {
  it("lets a platform admin block a domain in every community", async () => {
    await seedCommunity("beu");
    await seedCommunity("gate");
    await request(app)
      .post("/api/v1/admin/blocked-domains")
      .set(as("user_admin"))
      .send({ domain: "pirate.example" })
      .expect(201);
    addClerkUser("user_x", { email: "x@example.com", username: "xx" });
    for (const slug of ["beu", "gate"]) {
      await api("user_x", slug).post("/posts", { body: "get it https://pirate.example/book" }).expect(422);
    }
    await request(app)
      .post("/api/v1/admin/blocked-domains")
      .set(as("user_member"))
      .send({ domain: "p.example" })
      .expect(403);
  });
});
