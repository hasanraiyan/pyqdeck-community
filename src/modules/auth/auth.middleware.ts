import { getAuth } from "@clerk/express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "../../core/errors/AppError.js";
import { getAccountService } from "../accounts/account.module.js";
import type { AccountService } from "../accounts/account.service.js";
import { getMemberService } from "../members/member.module.js";
import type { MemberService } from "../members/member.service.js";
import type { MemberRole } from "../members/member.states.js";

/**
 * Resolves the Clerk session (if any) to the global account on `req.account`.
 *
 * Anonymous-friendly: no token means `req.account` stays undefined and the request carries on, so public routes keep
 * working. If Clerk is unreachable we also continue anonymously; protected routes then reject via `requireAuth`,
 * i.e. auth fails closed where it matters and open only for public reads.
 */
export const createAttachAccount =
  (service: AccountService = getAccountService()): RequestHandler =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const { userId } = getAuth(req) ?? {};
      if (userId) {
        const account = await service.resolveFromClerk(userId);
        if (account) req.account = account;
      }
    } catch (err) {
      req.log.error({ err }, "attachAccount failed, continuing anonymously");
    }
    next();
  };

/**
 * On community routes: gives a signed-in person their membership in `req.community`, creating it on first sight
 * (FR-AUTH-2). Membership in one community says nothing about any other (FR-COM-7).
 */
export const createAttachMember =
  (service: MemberService = getMemberService()): RequestHandler =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (req.account && req.account.status === "active" && req.community) {
        req.member = await service.ensureMember(req.community, req.account);
      }
    } catch (err) {
      req.log.error({ err }, "attachMember failed, continuing anonymously");
    }
    next();
  };

/** 401 when signed out or the account was deleted, 403 when suspended in this community. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const member = req.member;
  if (!member || member.status === "deleted") return next(AppError.unauthorized("Sign in to continue"));
  const suspended =
    member.status === "suspended" && !(member.suspendedUntil && member.suspendedUntil.getTime() <= Date.now());
  if (suspended) return next(AppError.forbidden("Your account is suspended"));
  next();
};

/** Use after `requireAuth`. Community admins pass every role check; so do platform admins (operators). */
export const requireRole =
  (...roles: MemberRole[]): RequestHandler =>
  (req, _res, next) => {
    const role = req.member?.role;
    if (!role) return next(AppError.unauthorized("Sign in to continue"));
    if (role !== "admin" && !roles.includes(role)) return next(AppError.forbidden("Insufficient permissions"));
    next();
  };

/** Platform operations (communities, storage). Needs only the global account, not a membership. */
export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  const account = req.account;
  if (!account || account.status === "deleted") return next(AppError.unauthorized("Sign in to continue"));
  if (account.platformRole !== "admin") return next(AppError.forbidden("Insufficient permissions"));
  next();
};

export const attachAccount = createAttachAccount();
export const attachMember = createAttachMember();
