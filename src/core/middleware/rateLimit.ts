import type { Request, RequestHandler } from "express";
import { env } from "../../config/env.js";
import { AppError } from "../errors/AppError.js";

interface Options {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** What to count by. Defaults to the signed-in member, else the client IP. */
  key?: (req: Request) => string;
  /** Overrides `RATE_LIMIT_SCALE` (tests). */
  scale?: number;
}

const defaultKey = (req: Request) => (req.member ? `m:${req.member.id}` : `ip:${req.ip}`);

/**
 * In-memory fixed-window limiter (NFR-SEC-2). Per process: with several instances the real limit is multiplied, so
 * move the counters to a shared store before scaling out. Sends 429 with Retry-After, which the app already honours.
 */
export function rateLimit({
  limit,
  windowMs,
  key = defaultKey,
  scale = env.RATE_LIMIT_SCALE,
}: Options): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = Date.now();

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const id = key(req);
    const entry = hits.get(id);
    if (!entry || entry.resetAt <= now) {
      hits.set(id, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++entry.count > limit * scale) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
      return next(AppError.tooManyRequests("Too many requests, please slow down"));
    }
    next();
  };
}
