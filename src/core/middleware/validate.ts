import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "../errors/AppError.js";

interface Schemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

/** Validates request parts with Zod. Parsed query lands in res.locals.query (req.query is read-only in Express 5). */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, res, next) => {
    for (const part of ["body", "params", "query"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        return next(AppError.badRequest("Validation failed", result.error.flatten().fieldErrors));
      }
      if (part === "query") res.locals.query = result.data;
      else req[part] = result.data as never;
    }
    next();
  };
