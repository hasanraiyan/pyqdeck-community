import { Router } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { rateLimit } from "../../core/middleware/rateLimit.js";
import { validate } from "../../core/middleware/validate.js";
import { sendSuccess } from "../../core/utils/response.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import { REPORT_REASONS, REPORT_TARGETS } from "./report.model.js";
import type { ReportService } from "./report.service.js";

const createSchema = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: z.string().trim().min(1).max(100),
  reason: z.enum(REPORT_REASONS),
  note: z.string().trim().max(300).optional(),
});
const resolveSchema = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: z.string().trim().min(1).max(100),
  outcome: z.enum(["actioned", "dismissed"]),
  remove: z.boolean().optional(),
});
const queueQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function createReportRoutes(service: ReportService) {
  const router = Router({ mergeParams: true });

  router.post(
    "/",
    requireAuth,
    rateLimit({ limit: 20, windowMs: 24 * 3_600_000 }),
    validate({ body: createSchema }),
    async (req, res) => {
      sendSuccess(res, await service.create(req.community!, req.member!, req.body), StatusCodes.CREATED);
    },
  );

  // Moderators: open reports grouped by target, then close a group with an outcome.
  router.get("/", requireAuth, requireRole("moderator"), validate({ query: queueQuery }), async (req, res) => {
    const { page, limit } = res.locals.query;
    const result = await service.queue(req.community!, page, limit);
    res
      .status(StatusCodes.OK)
      .json({ success: true, data: result.items, pagination: { page, limit, hasMore: result.hasMore } });
  });
  router.post(
    "/resolve",
    requireAuth,
    requireRole("moderator"),
    validate({ body: resolveSchema }),
    async (req, res) => {
      sendSuccess(res, await service.resolve(req.community!, req.member!, req.body));
    },
  );

  return router;
}
