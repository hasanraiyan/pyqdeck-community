import type { Request } from "express";
import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { rateLimit } from "../../src/core/middleware/rateLimit.js";
import { defineMachine } from "../../src/core/state/state-machine.js";
import { cursorCondition, encodeCursor, toCursorPage } from "../../src/core/utils/cursor.js";
import { communityMachine } from "../../src/modules/communities/community.states.js";
import { commentMachine } from "../../src/modules/comments/comment.model.js";
import { decideClick, type ClickFacts } from "../../src/modules/links/link.decision.js";
import { linkMachine } from "../../src/modules/links/link.model.js";
import { HeuristicReputationProvider, ReputationChain } from "../../src/modules/links/link.reputation.js";
import { memberMachine } from "../../src/modules/members/member.states.js";
import { extractHashtags, slugify } from "../../src/modules/posts/hashtags.js";
import { postMachine } from "../../src/modules/posts/post.states.js";
import { reportMachine } from "../../src/modules/reports/report.model.js";

describe("state machines", () => {
  const cases = {
    post: [
      postMachine,
      {
        published: ["pending", "rejected", "deleted"],
        pending: ["published", "rejected", "deleted"],
        rejected: ["deleted"],
        deleted: [],
      },
    ],
    comment: [
      commentMachine,
      {
        published: ["pending", "rejected", "deleted"],
        pending: ["published", "rejected", "deleted"],
        rejected: ["deleted"],
        deleted: [],
      },
    ],
    member: [memberMachine, { active: ["suspended", "deleted"], suspended: ["active", "deleted"], deleted: [] }],
    community: [
      communityMachine,
      { active: ["read_only", "disabled"], read_only: ["active", "disabled"], disabled: ["active"] },
    ],
    report: [reportMachine, { open: ["actioned", "dismissed"], actioned: [], dismissed: [] }],
    link: [linkMachine, { inactive: ["active", "blocked"], active: ["inactive", "blocked"], blocked: ["inactive"] }],
  } as const;

  // Every ordered pair of states is either allowed or refused exactly as STATE-MACHINES.md says.
  for (const [name, [machine, table]] of Object.entries(cases)) {
    it(`${name}: allows exactly the documented transitions`, () => {
      const t = table as Record<string, readonly string[]>;
      for (const from of machine.states) {
        for (const to of machine.states) {
          expect(machine.canTransition(from as never, to as never), `${from} -> ${to}`).toBe(t[from].includes(to));
        }
      }
    });
  }

  it("refuses an illegal move with a 409 that names both states", () => {
    expect(() => postMachine.assertTransition("rejected", "published")).toThrowError(/rejected to published/);
    expect(() => postMachine.assertTransition("pending", "published")).not.toThrow();
  });

  it("treats a state with no exits as terminal and lists who may move to a target", () => {
    expect(postMachine.allowedFrom("deleted").sort()).toEqual(["pending", "published", "rejected"]);
    expect(postMachine.allowedFrom("published")).toEqual(["pending"]);
    expect(memberMachine.canTransition("deleted", "active")).toBe(false);
  });

  it("renders a Mermaid diagram from the table", () => {
    const m = defineMachine<"a" | "b">("X", { a: ["b"], b: [] });
    expect(m.toMermaid()).toBe("stateDiagram-v2\n  a --> b");
  });
});

describe("cursor pagination", () => {
  const row = (ms: number) => ({ _id: new Types.ObjectId(), createdAt: new Date(ms) });

  it("flags another page only when an extra row was fetched", () => {
    const rows = [row(3), row(2), row(1)];
    const page = toCursorPage(rows, 2);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(encodeCursor(rows[1]));
    expect(toCursorPage(rows, 3)).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("builds a stable (createdAt, _id) condition for either direction", () => {
    const r = row(5);
    const desc = cursorCondition(encodeCursor(r), "desc") as { $or: Array<Record<string, unknown>> };
    expect(desc.$or[0]).toEqual({ createdAt: { $lt: r.createdAt } });
    const asc = cursorCondition(encodeCursor(r), "asc") as { $or: Array<Record<string, unknown>> };
    expect(asc.$or[1]).toMatchObject({ _id: { $gt: r._id } });
    expect(cursorCondition(undefined, "desc")).toEqual({});
  });

  it.each([
    "garbage",
    Buffer.from("{}").toString("base64url"),
    Buffer.from('{"t":"x","id":"y"}').toString("base64url"),
  ])("rejects a malformed cursor (%s)", (c) => expect(() => cursorCondition(c, "desc")).toThrowError(/Invalid cursor/));
});

describe("rate limiter", () => {
  const run = (limiter: ReturnType<typeof rateLimit>, now = Date.now()) => {
    const headers: Record<string, unknown> = {};
    const next = vi.fn();
    vi.setSystemTime(now);
    limiter({ ip: "1.1.1.1" } as Request, { setHeader: (k: string, v: unknown) => (headers[k] = v) } as never, next);
    return { headers, error: next.mock.calls[0]?.[0] as { statusCode?: number } | undefined };
  };

  it("allows up to the limit, then answers 429 with Retry-After until the window passes", () => {
    vi.useFakeTimers();
    const limiter = rateLimit({ limit: 2, windowMs: 60_000, scale: 1 });
    const t0 = Date.now();
    expect(run(limiter, t0).error).toBeUndefined();
    expect(run(limiter, t0 + 1000).error).toBeUndefined();
    const blocked = run(limiter, t0 + 10_000);
    expect(blocked.error?.statusCode).toBe(429);
    expect(blocked.headers["Retry-After"]).toBe(50);
    expect(run(limiter, t0 + 61_000).error).toBeUndefined();
    vi.useRealTimers();
  });

  it("counts members separately", () => {
    vi.useFakeTimers();
    const limiter = rateLimit({ limit: 1, windowMs: 1000, scale: 1, key: (r) => String((r as { k?: string }).k) });
    const call = (k: string) => {
      const next = vi.fn();
      limiter({ k } as never, { setHeader: () => undefined } as never, next);
      return next.mock.calls[0]?.[0];
    };
    expect(call("a")).toBeUndefined();
    expect(call("b")).toBeUndefined();
    expect(call("a")).toBeDefined();
    vi.useRealTimers();
  });
});

describe("hashtags and slugs", () => {
  it("de-duplicates case-insensitively, keeps the first spelling and the first ten", () => {
    expect(extractHashtags("#Maths #maths #A_b-c #x").display).toEqual(["Maths", "A_b-c", "x"]);
    expect(extractHashtags(Array.from({ length: 15 }, (_, i) => `#t${i}`).join(" ")).display).toHaveLength(10);
  });

  it("needs a word boundary before the #", () => {
    expect(extractHashtags("a#b &#39; mid#tag #ok").display).toEqual(["ok"]);
  });

  it("makes readable slugs", () => {
    expect(slugify("Explaining Dijkstra's algorithm!")).toBe("explaining-dijkstra-s-algorithm");
    expect(slugify("???")).toBe("");
    expect(slugify("x".repeat(100))).toHaveLength(40);
  });
});

describe("link click decision (first matching rule wins)", () => {
  const facts = (over: Partial<ClickFacts> = {}): ClickFacts => ({
    exists: true,
    status: "active",
    verdict: "clean",
    domainBlocked: false,
    lookalike: false,
    recheckFailed: false,
    ...over,
  });

  it.each([
    [{ exists: false }, "notfound"],
    [{ status: "inactive" as const }, "gone"],
    [{ status: "blocked" as const }, "blocked"],
    [{ verdict: "malicious" as const }, "blocked"],
    [{ domainBlocked: true }, "blocked"],
    [{ recheckFailed: true }, "warn"],
    [{ verdict: "suspicious" as const }, "warn"],
    [{ verdict: "unchecked" as const }, "warn"],
    [{ lookalike: true }, "warn"],
    [{}, "redirect"],
  ])("%j -> %s", (over, kind) => {
    expect(decideClick(facts(over)).kind).toBe(kind);
  });

  it("lets Continue override warnings but never blocks, gone or unknown links", () => {
    expect(decideClick(facts({ verdict: "suspicious" }), true).kind).toBe("redirect");
    expect(decideClick(facts({ lookalike: true, recheckFailed: true }), true).kind).toBe("redirect");
    expect(decideClick(facts({ verdict: "malicious" }), true).kind).toBe("blocked");
    expect(decideClick(facts({ status: "inactive" }), true).kind).toBe("gone");
    expect(decideClick(facts({ exists: false }), true).kind).toBe("notfound");
  });
});

describe("reputation chain", () => {
  const provider = (name: string, verdict: "clean" | "suspicious" | "malicious" | "throw") => ({
    name,
    check: async () => {
      if (verdict === "throw") throw new Error("down");
      return { verdict, source: name };
    },
  });

  it("keeps the worst verdict", async () => {
    expect(
      (await new ReputationChain([provider("a", "clean"), provider("b", "malicious")]).check("u", "h")).verdict,
    ).toBe("malicious");
    expect(
      (await new ReputationChain([provider("a", "suspicious"), provider("b", "clean")]).check("u", "h")).verdict,
    ).toBe("suspicious");
  });

  it("never reports clean when a source failed to answer", async () => {
    expect((await new ReputationChain([provider("a", "clean"), provider("b", "throw")]).check("u", "h")).verdict).toBe(
      "unchecked",
    );
    expect((await new ReputationChain([]).check("u", "h")).verdict).toBe("unchecked");
    // a source that did find something still wins over a failure
    expect(
      (await new ReputationChain([provider("a", "malicious"), provider("b", "throw")]).check("u", "h")).verdict,
    ).toBe("malicious");
  });

  it("flags IP hosts, punycode, risky TLDs and credential bait locally", async () => {
    const h = new HeuristicReputationProvider();
    for (const host of [
      "203.0.113.9",
      "xn--pple-43d.com",
      "free-stuff.tk",
      "a.b.c.d.e.f.example.com",
      "secure-login.paypal.example.com",
    ]) {
      expect((await h.check(`https://${host}/`, host)).verdict, host).toBe("suspicious");
    }
    expect((await h.check("https://github.com/x", "github.com")).verdict).toBe("clean");
  });
});
