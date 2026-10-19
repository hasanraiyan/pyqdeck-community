import type { RequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../../core/errors/AppError.js";
import { CommunityRepository } from "./community.repository.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Resolves `:community` from the path and nothing else (NFR-ISO-3). An unknown or disabled community answers 404 with
 * no hint that others exist (IR-API-12); a `read_only` one keeps serving reads and refuses writes (FR-COM-12).
 */
export const createResolveCommunity =
  (repository = new CommunityRepository()): RequestHandler =>
  async (req, _res, next) => {
    const slug = String(req.params.community ?? "").toLowerCase();
    const community = slug ? await repository.findBySlug(slug) : null;
    if (!community || community.status === "disabled") throw AppError.notFound("Community not found");
    if (community.status === "read_only" && !SAFE_METHODS.has(req.method)) {
      throw new AppError(StatusCodes.FORBIDDEN, "This community is read-only right now");
    }
    req.community = community;
    next();
  };
