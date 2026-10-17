import { describe, expect, it } from "vitest";
import { buildPageMeta, paginationQuerySchema, toMongoSort } from "../../src/core/utils/pagination.js";

describe("paginationQuerySchema", () => {
  it("applies defaults", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, limit: 20, sort: "-createdAt" });
  });

  it("coerces numeric strings from the query string", () => {
    expect(paginationQuerySchema.parse({ page: "3", limit: "50" })).toMatchObject({ page: 3, limit: 50 });
  });

  it.each([{ page: "0" }, { page: "1.5" }, { limit: "0" }, { limit: "101" }, { page: "abc" }])(
    "rejects %o",
    (query) => {
      expect(paginationQuerySchema.safeParse(query).success).toBe(false);
    },
  );

  it.each(["name", "-name", "-createdAt,name", "profile.age"])("accepts sort %s", (sort) => {
    expect(paginationQuerySchema.safeParse({ sort }).success).toBe(true);
  });

  it.each(["", "name desc", "$where", "a,,b", "name;drop"])("rejects sort %j", (sort) => {
    expect(paginationQuerySchema.safeParse({ sort }).success).toBe(false);
  });
});

describe("buildPageMeta", () => {
  it("computes the middle page", () => {
    expect(buildPageMeta(45, 2, 10)).toEqual({
      total: 45,
      page: 2,
      limit: 10,
      totalPages: 5,
      hasNext: true,
      hasPrev: true,
    });
  });

  it("flags the last page", () => {
    expect(buildPageMeta(45, 5, 10)).toMatchObject({ hasNext: false, hasPrev: true });
  });

  it("reports one page when empty", () => {
    expect(buildPageMeta(0, 1, 20)).toMatchObject({ totalPages: 1, hasNext: false, hasPrev: false });
  });
});

describe("toMongoSort", () => {
  it("converts comma separated fields to a mongoose sort string", () => {
    expect(toMongoSort("-createdAt,name")).toBe("-createdAt name");
  });
});
