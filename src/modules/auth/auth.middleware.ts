import { getAuth } from "@clerk/express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "../../core/errors/AppError.js";
import type { UserRole } from "../users/user.model.js";
import { UserService } from "../users/user.service.js";

/**
 * Resolves the Clerk session (if any) to a community profile on `req.user`.
 *
 * Anonymous-friendly: no token means `req.user` stays undefined and the request carries on, so public routes keep
 * working. If Clerk is unreachable we also continue anonymously; protected routes then reject via `requireAuth`,
 * i.e. auth fails closed where it matters and open only for public reads.
 */
export const createAttachUser =
  (service = new UserService()): RequestHandler =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const { userId } = getAuth(req) ?? {};
      if (userId) {
        const user = await service.resolveFromClerk(userId);
        if (user) req.user = user;
      }
    } catch (err) {
      req.log.error({ err }, "attachUser failed, continuing anonymously");
    }
    next();
  };

export const attachUser = createAttachUser();

/** 401 when signed out or the account was deleted, 403 when suspended. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const user = req.user;
  if (!user || user.status === "deleted") return next(AppError.unauthorized("Sign in to continue"));
  if (user.status === "suspended") return next(AppError.forbidden("Your account is suspended"));
  next();
};

/** Use after `requireAuth`. Admins pass every role check. */
export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    const role = req.user?.role;
    if (!role) return next(AppError.unauthorized("Sign in to continue"));
    if (role !== "admin" && !roles.includes(role)) return next(AppError.forbidden("Insufficient permissions"));
    next();
  };
