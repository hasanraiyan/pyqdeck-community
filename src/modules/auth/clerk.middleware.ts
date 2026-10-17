import { clerkMiddleware } from "@clerk/express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { env } from "../../config/env.js";

const clerk = clerkMiddleware({ publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY });

/**
 * Verifies the Clerk session token (Authorization: Bearer) and populates the request auth.
 *
 * clerkMiddleware throws when its keys are missing or malformed, which on a global mount would 500 every request
 * including public ones. So failures are logged and the request continues unauthenticated; `requireAuth` then
 * rejects it, which keeps protected routes closed.
 */
export const clerkAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  let settled = false;
  const done = (err?: unknown) => {
    if (settled) return;
    settled = true;
    if (err) req.log.error({ err }, "clerkMiddleware failed, continuing unauthenticated");
    next();
  };

  try {
    void Promise.resolve(clerk(req, res, done)).catch(done);
  } catch (err) {
    done(err);
  }
};
