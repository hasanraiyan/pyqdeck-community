import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";
import { testRoutes } from "../helpers/widget.js";

const app = createApp(testRoutes);

describe("GET /api/health (database not connected)", () => {
  it("reports degraded", async () => {
    const res = await request(app).get("/api/health").expect(200);
    expect(res.body).toMatchObject({ success: true, data: { status: "degraded", database: "disconnected" } });
  });
});

describe("GET /api/health (database connected)", () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);

  it("reports ok", async () => {
    const res = await request(app).get("/api/health").expect(200);
    expect(res.body.data).toMatchObject({ status: "ok", database: "connected" });
    expect(typeof res.body.data.uptime).toBe("number");
    expect(Number.isNaN(Date.parse(res.body.data.timestamp))).toBe(false);
  });
});

describe("request ids", () => {
  it("generates an id and echoes it in the response header", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses a well-formed incoming id", async () => {
    const res = await request(app).get("/api/health").set("x-request-id", "trace-abc-12345");
    expect(res.headers["x-request-id"]).toBe("trace-abc-12345");
  });

  it("replaces a malformed incoming id", async () => {
    const res = await request(app).get("/api/health").set("x-request-id", "bad id!");
    expect(res.headers["x-request-id"]).not.toBe("bad id!");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("includes the id in error bodies", async () => {
    const res = await request(app).get("/api/nope").set("x-request-id", "trace-err-12345").expect(404);
    expect(res.body).toEqual({
      success: false,
      message: "Route GET /api/nope not found",
      code: "not_found",
      requestId: "trace-err-12345",
    });
  });
});

describe("error handling", () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);

  it("returns 400 for malformed JSON", async () => {
    const res = await request(app)
      .post("/api/widgets")
      .set("content-type", "application/json")
      .send("{bad")
      .expect(400);
    expect(res.body).toMatchObject({ success: false, message: "Malformed JSON body" });
  });
});

describe("docs and compression", () => {
  it("serves the OpenAPI spec", async () => {
    const res = await request(app).get("/api/docs/json").expect(200);
    expect(res.body.openapi).toBe("3.0.3");
    expect(res.body.paths).toHaveProperty("/health");
  });

  it("serves the Swagger UI", async () => {
    const res = await request(app).get("/api/docs/").expect(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("gzips large responses", async () => {
    const res = await request(app).get("/api/docs/json").set("accept-encoding", "gzip").expect(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("sets security headers", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("cleanup helper", () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);

  it("clearTestDb is safe on an empty database", async () => {
    await expect(clearTestDb()).resolves.toBeUndefined();
  });
});
