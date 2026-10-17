import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors/AppError.js";

describe("AppError", () => {
  it.each([
    ["badRequest", StatusCodes.BAD_REQUEST, "Bad Request"],
    ["unauthorized", StatusCodes.UNAUTHORIZED, "Unauthorized"],
    ["forbidden", StatusCodes.FORBIDDEN, "Forbidden"],
    ["notFound", StatusCodes.NOT_FOUND, "Not Found"],
    ["conflict", StatusCodes.CONFLICT, "Conflict"],
    ["unprocessable", StatusCodes.UNPROCESSABLE_ENTITY, "Unprocessable Entity"],
    ["tooManyRequests", StatusCodes.TOO_MANY_REQUESTS, "Too Many Requests"],
    ["internal", StatusCodes.INTERNAL_SERVER_ERROR, "Internal Server Error"],
  ] as const)("%s() uses status %i and a default reason phrase", (factory, status, phrase) => {
    const err = AppError[factory]();
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(status);
    expect(err.message).toBe(phrase);
  });

  it("keeps a custom message and details", () => {
    const err = AppError.badRequest("Nope", { field: "name" });
    expect(err.message).toBe("Nope");
    expect(err.details).toEqual({ field: "name" });
  });
});
