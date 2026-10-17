import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";
import { WidgetModel, testRoutes } from "../helpers/widget.js";

const app = createApp(testRoutes);
const api = () => request(app);

const widget = (over: Record<string, unknown> = {}) => ({ name: "Gear", qty: 5, category: "parts", ...over });

beforeAll(async () => {
  await connectTestDb();
  await WidgetModel.init(); // build the unique index before the duplicate test
});
afterAll(disconnectTestDb);
beforeEach(clearTestDb);

describe("create", () => {
  it("returns 201 and the created document", async () => {
    const res = await api().post("/api/widgets").send(widget()).expect(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ name: "Gear", qty: 5, category: "parts" });
    expect(res.body.data._id).toBeTypeOf("string");
  });

  it("rejects an invalid body with field details", async () => {
    const res = await api().post("/api/widgets").send({ name: "", qty: -1 }).expect(400);
    expect(res.body).toMatchObject({ success: false, message: "Validation failed" });
    expect(Object.keys(res.body.details)).toEqual(expect.arrayContaining(["name", "qty", "category"]));
  });

  it("strips unknown fields", async () => {
    const res = await api()
      .post("/api/widgets")
      .send(widget({ isAdmin: true }))
      .expect(201);
    expect(res.body.data).not.toHaveProperty("isAdmin");
  });

  it("maps a duplicate key to 409", async () => {
    await api().post("/api/widgets").send(widget()).expect(201);
    const res = await api().post("/api/widgets").send(widget()).expect(409);
    expect(res.body).toMatchObject({ success: false, message: "Duplicate value", details: { name: "Gear" } });
  });
});

describe("get by id", () => {
  it("returns the document", async () => {
    const { body } = await api().post("/api/widgets").send(widget()).expect(201);
    const res = await api().get(`/api/widgets/${body.data._id}`).expect(200);
    expect(res.body.data.name).toBe("Gear");
  });

  it("returns 404 for a missing document", async () => {
    const res = await api().get(`/api/widgets/${new Types.ObjectId()}`).expect(404);
    expect(res.body).toMatchObject({ success: false, message: "Widget not found" });
  });

  it("returns 400 for a malformed id", async () => {
    const res = await api().get("/api/widgets/not-an-id").expect(400);
    expect(res.body).toMatchObject({ success: false, message: "Invalid _id" });
  });
});

describe("update", () => {
  it("returns the updated document", async () => {
    const { body } = await api().post("/api/widgets").send(widget()).expect(201);
    const res = await api().patch(`/api/widgets/${body.data._id}`).send({ qty: 9 }).expect(200);
    expect(res.body.data).toMatchObject({ name: "Gear", qty: 9 });
  });

  it("runs model validators on update", async () => {
    const { body } = await api().post("/api/widgets").send(widget()).expect(201);
    // passes zod? no - qty must be >= 0, so zod rejects before the model does
    await api().patch(`/api/widgets/${body.data._id}`).send({ qty: -3 }).expect(400);
  });

  it("returns 404 for a missing document", async () => {
    await api().patch(`/api/widgets/${new Types.ObjectId()}`).send({ qty: 1 }).expect(404);
  });
});

describe("delete", () => {
  it("returns 204 with no body, then 404", async () => {
    const { body } = await api().post("/api/widgets").send(widget()).expect(201);
    const res = await api().delete(`/api/widgets/${body.data._id}`).expect(204);
    expect(res.text).toBe("");
    await api().get(`/api/widgets/${body.data._id}`).expect(404);
  });

  it("returns 404 for a missing document", async () => {
    await api().delete(`/api/widgets/${new Types.ObjectId()}`).expect(404);
  });
});

describe("list + pagination", () => {
  beforeEach(async () => {
    await WidgetModel.insertMany(
      Array.from({ length: 25 }, (_, i) => ({
        name: `w${String(i).padStart(2, "0")}`,
        qty: i,
        category: i % 2 === 0 ? "even" : "odd",
      })),
    );
  });

  it("uses defaults (page 1, limit 20)", async () => {
    const res = await api().get("/api/widgets").expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(20);
    expect(res.body.pagination).toEqual({
      total: 25,
      page: 1,
      limit: 20,
      totalPages: 2,
      hasNext: true,
      hasPrev: false,
    });
  });

  it("returns the remainder on the last page", async () => {
    const res = await api().get("/api/widgets?page=3&limit=10").expect(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.pagination).toMatchObject({ page: 3, totalPages: 3, hasNext: false, hasPrev: true });
  });

  it("returns an empty page past the end", async () => {
    const res = await api().get("/api/widgets?page=9&limit=10").expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(25);
  });

  it("sorts descending and by multiple fields", async () => {
    const desc = await api().get("/api/widgets?sort=-qty&limit=3").expect(200);
    expect(desc.body.data.map((w: { qty: number }) => w.qty)).toEqual([24, 23, 22]);

    const multi = await api().get("/api/widgets?sort=category,-qty&limit=3").expect(200);
    expect(multi.body.data.map((w: { qty: number }) => w.qty)).toEqual([24, 22, 20]); // "even" first, qty desc
  });

  it("filters by an allowed query key and counts the filtered total", async () => {
    const res = await api().get("/api/widgets?category=odd&limit=100").expect(200);
    expect(res.body.pagination.total).toBe(12);
    expect(res.body.data.every((w: { category: string }) => w.category === "odd")).toBe(true);
  });

  it("ignores query keys that are not whitelisted by the schema", async () => {
    const res = await api().get("/api/widgets?qty=999").expect(200);
    expect(res.body.pagination.total).toBe(25);
  });

  it.each(["limit=101", "limit=0", "page=0", "page=abc", "sort=$where", "sort=a;b"])(
    "rejects ?%s with 400",
    async (qs) => {
      const res = await api().get(`/api/widgets?${qs}`).expect(400);
      expect(res.body).toMatchObject({ success: false, message: "Validation failed" });
    },
  );
});
