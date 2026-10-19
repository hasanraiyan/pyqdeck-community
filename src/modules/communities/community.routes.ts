import { Router } from "express";
import { StatusCodes } from "http-status-codes";
import { validate } from "../../core/middleware/validate.js";
import { sendSuccess } from "../../core/utils/response.js";
import { requirePlatformAdmin } from "../auth/auth.middleware.js";
import { limitsOf, type ICommunity } from "./community.model.js";
import { getCommunityService } from "./community.module.js";
import { createCommunitySchema, setStatusSchema, slugParamSchema, updateCommunitySchema } from "./community.schema.js";
import type { CommunityService } from "./community.service.js";

export const toCommunityDto = (c: Pick<ICommunity, "slug" | "name" | "status" | "limits" | "profileSchema">) => ({
  slug: c.slug,
  name: c.name,
  status: c.status,
  limits: limitsOf(c),
  profileSchema: c.profileSchema ?? null,
});

/** Platform admin only: create, list, update and enable or disable communities without redeploying (FR-COM-4). */
export function createCommunityAdminRoutes(service: CommunityService = getCommunityService()) {
  const router = Router();
  router.use(requirePlatformAdmin);

  router.get("/", async (_req, res) => {
    sendSuccess(res, (await service.list()).map(toCommunityDto));
  });
  router.post("/", validate({ body: createCommunitySchema }), async (req, res) => {
    sendSuccess(res, toCommunityDto(await service.create(req.body)), StatusCodes.CREATED);
  });
  router.patch("/:slug", validate({ params: slugParamSchema, body: updateCommunitySchema }), async (req, res) => {
    sendSuccess(res, toCommunityDto(await service.update(String(req.params.slug), req.body)));
  });
  router.put("/:slug/status", validate({ params: slugParamSchema, body: setStatusSchema }), async (req, res) => {
    sendSuccess(res, toCommunityDto(await service.setStatus(String(req.params.slug), req.body.status)));
  });
  return router;
}

/** Public: what an app needs to know about the community it is talking to (limits, status). */
export function createCommunityInfoRoutes() {
  const router = Router({ mergeParams: true });
  router.get("/", (req, res) => {
    sendSuccess(res, toCommunityDto(req.community!));
  });
  return router;
}
