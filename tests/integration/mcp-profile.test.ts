import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addClerkUser, clerkUsers } from "../helpers/clerk.js";
import { client } from "../helpers/client.js";
import { seedCommunity, setMemberRole } from "../helpers/community.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";

vi.mock("@clerk/express", async () => (await import("../helpers/clerk.js")).clerkModule);

const { createApp } = await import("../../src/app.js");
const { getServices } = await import("../../src/composition.js");
const { getAccountService } = await import("../../src/modules/accounts/account.module.js");
const { getCommunityService } = await import("../../src/modules/communities/community.module.js");
const { MemberModel } = await import("../../src/modules/members/member.model.js");
const { ProfileTool } = await import("../../src/modules/mcp/mcp.profile.js");
const { createMcpServer } = await import("../../src/modules/mcp/mcp.server.js");

type Profile = {
  username: string;
  email?: string;
  displayName: string;
  headline: string;
  bio: string;
  location: string;
  github: string;
  skills: string[];
};

const app = createApp();
const api = client(app);

const tool = () =>
  new ProfileTool({
    accounts: getAccountService(),
    communities: getCommunityService(),
    members: getServices().members,
    social: getServices().social,
  });
const run = (clerkId: string | undefined, input: Parameters<ReturnType<typeof tool>["run"]>[1]) =>
  tool().run(clerkId, input) as Promise<Profile>;

beforeAll(async () => {
  await connectTestDb();
  await MemberModel.init();
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearTestDb();
  await seedCommunity();
  clerkUsers.clear();
  addClerkUser("user_a", { email: "alice@example.com", username: "alice" });
  addClerkUser("user_b", { email: "bob@example.com", username: "bobby" });
  await api("user_a").get("/members/me").expect(200);
  await api("user_b").get("/members/me").expect(200);
});

describe("manage_profile: read", () => {
  it("returns your own profile, with the private fields", async () => {
    const me = await run("user_a", { action: "read" });
    expect(me).toMatchObject({ username: "alice", email: "alice@example.com" });
  });

  it("returns another member's public profile only", async () => {
    const other = await run("user_a", { action: "read", handle: "@Bobby" });
    expect(other).toMatchObject({ username: "bobby" });
    expect(other).not.toHaveProperty("email");
  });

  it("answers 'not found' for a member who blocked you", async () => {
    await api("user_b").put("/members/alice/block").expect(204);
    await expect(run("user_a", { action: "read", handle: "bobby" })).rejects.toThrow("Member not found");
  });

  it("searches members and leaves out the ones hidden from you", async () => {
    const found = (await run("user_a", { action: "search", q: "bo" })) as unknown as Array<{ username: string }>;
    expect(found.map((m) => m.username)).toEqual(["bobby"]);

    await api("user_b").put("/members/alice/block").expect(204);
    expect(await run("user_a", { action: "search", q: "bo" })).toEqual([]);
  });
});

describe("manage_profile: writing", () => {
  it("patch changes only what was sent", async () => {
    await run("user_a", { action: "patch", headline: "BEU CSE", bio: "Hello", skills: ["c", "dsa"] });
    const after = await run("user_a", { action: "patch", location: "Patna" });
    expect(after).toMatchObject({ headline: "BEU CSE", bio: "Hello", location: "Patna", skills: ["c", "dsa"] });
  });

  it("patch cleans a social link down to its handle, like the API", async () => {
    const after = await run("user_a", { action: "patch", github: "https://github.com/alice-dev" });
    expect(after.github).toBe("alice-dev");
  });

  it("patch with nothing to change is refused", async () => {
    await expect(run("user_a", { action: "patch" })).rejects.toThrow("at least one field");
  });

  it("update replaces the whole profile: what is left out is emptied", async () => {
    await run("user_a", { action: "patch", headline: "old", bio: "old bio", skills: ["x"], location: "Patna" });
    const after = await run("user_a", { action: "update", displayName: "Alice A", bio: "new bio" });
    expect(after).toMatchObject({ displayName: "Alice A", bio: "new bio", headline: "", location: "", skills: [] });
  });

  it("update needs a display name", async () => {
    await expect(run("user_a", { action: "update", bio: "x" })).rejects.toThrow("needs displayName");
  });

  it("clear empties the named fields and leaves the rest", async () => {
    await run("user_a", { action: "patch", headline: "h", bio: "b", skills: ["x"] });
    const after = await run("user_a", { action: "clear", fields: ["headline", "skills"] });
    expect(after).toMatchObject({ headline: "", skills: [], bio: "b" });
    await expect(run("user_a", { action: "clear" })).rejects.toThrow("needs `fields`");
  });

  it("refuses invalid values with a readable message", async () => {
    await expect(run("user_a", { action: "patch", website: "javascript:alert(1)" })).rejects.toThrow("website");
  });

  it("goes through the same moderation as the API (a word-filter hit is refused)", async () => {
    await expect(run("user_a", { action: "patch", bio: "you are a fucking idiot" })).rejects.toThrow();
  });

  it("cannot change someone else's profile: only the signed-in person's own membership is ever edited", async () => {
    await run("user_a", { action: "patch", headline: "mine" });
    expect((await run("user_b", { action: "read" })).headline).toBe("");
  });

  it("is refused while the community is read-only, but reading still works", async () => {
    const { CommunityModel } = await import("../../src/modules/communities/community.model.js");
    await CommunityModel.updateOne({ slug: "beu" }, { status: "read_only" });
    await expect(run("user_a", { action: "patch", headline: "x" })).rejects.toThrow("read-only");
    expect(await run("user_a", { action: "read" })).toMatchObject({ username: "alice" });
  });

  it("is refused for a suspended member", async () => {
    await setMemberRole("user_a", "member");
    await MemberModel.updateOne({ username: "alice" }, { status: "suspended" });
    await expect(run("user_a", { action: "read" })).rejects.toThrow("suspended");
  });
});

describe("manage_profile: who is asking", () => {
  it("needs a signed-in person", async () => {
    await expect(run(undefined, { action: "read" })).rejects.toThrow("Sign in");
  });

  it("an unknown community is a plain 'not found'", async () => {
    await expect(run("user_a", { action: "read", community: "nope" })).rejects.toThrow("Community not found");
  });
});

describe("the MCP server itself", () => {
  const connect = async () => {
    const server = createMcpServer(tool());
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "test", version: "1" });
    await mcp.connect(clientSide);
    return mcp;
  };

  it("exposes exactly one tool, manage_profile, with the action enum", async () => {
    const mcp = await connect();
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual(["manage_profile"]);
    const action = (tools[0].inputSchema.properties as Record<string, { enum?: string[] }>).action;
    expect(action.enum).toEqual(["read", "search", "update", "patch", "clear"]);
  });

  it("answers a call without a signed-in person with an error result, not a crash", async () => {
    const mcp = await connect();
    const result = (await mcp.callTool({ name: "manage_profile", arguments: { action: "read" } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Sign in");
  });

  it("is protected over HTTP: no token is a 401 with the discovery pointer", async () => {
    const request = (await import("supertest")).default;
    const res = await request(app).post("/mcp").send({}).expect(401);
    expect(res.headers["www-authenticate"]).toContain("resource_metadata");
    await request(app).get("/mcp").expect(405);
  });
});
