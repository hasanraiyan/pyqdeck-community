import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { rateLimit } from "../../core/middleware/rateLimit.js";
import { validate } from "../../core/middleware/validate.js";
import { cursorQuerySchema } from "../../core/utils/cursor.js";
import { sendCursorPage, sendNoContent, sendSuccess } from "../../core/utils/response.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import { idempotencyKeyFrom } from "../idempotency/idempotency.js";
import type { CommentPresenter } from "./comment.presenter.js";
import type { CommentService } from "./comment.service.js";

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");
const postParam = z.object({ id: z.string().trim().min(1).max(120) });
const commentParam = z.object({ commentId: objectId });
const createSchema = z.object({ body: z.string().max(5000), parentId: objectId.optional() });
const editSchema = z.object({ body: z.string().max(5000) });
const moderateSchema = z.object({
  action: z.enum(["approve", "remove", "reject_edit"]),
  reason: z.enum(["spam", "harassment", "hate", "sexual", "violence", "misinformation", "other"]).optional(),
});

/** Mounted under `/posts` (`/:id/comments`) and `/comments`. */
export function createCommentRoutes(service: CommentService, presenter: CommentPresenter) {
  const postScoped = Router({ mergeParams: true });
  postScoped.get("/:id/comments", validate({ params: postParam, query: cursorQuerySchema }), async (req, res) => {
    const { cursor, limit } = res.locals.query;
    const page = await service.list(req.community!, req.member, String(req.params.id), cursor, limit);
    sendCursorPage(res, await presenter.present(page.items, req.member), page);
  });
  postScoped.post(
    "/:id/comments",
    requireAuth,
    rateLimit({ limit: 60, windowMs: 3_600_000 }),
    validate({ params: postParam, body: createSchema }),
    async (req, res) => {
      const comment = await service.create(req.community!, req.member!, String(req.params.id), {
        ...req.body,
        idempotencyKey: idempotencyKeyFrom(req.get("idempotency-key")),
      });
      sendSuccess(res, await presenter.presentOne(comment, req.member), StatusCodes.CREATED);
    },
  );

  const comments = Router({ mergeParams: true });
  comments.get(
    "/queue",
    requireAuth,
    requireRole("moderator"),
    validate({ query: cursorQuerySchema }),
    async (req, res) => {
      const { cursor, limit } = res.locals.query;
      const page = await service.queue(req.community!, cursor, limit);
      sendCursorPage(res, await presenter.present(page.items, req.member), page);
    },
  );
  comments.get(
    "/:commentId/replies",
    validate({ params: commentParam, query: cursorQuerySchema }),
    async (req, res) => {
      const { cursor, limit } = res.locals.query;
      const page = await service.replies(req.community!, req.member, String(req.params.commentId), cursor, limit);
      sendCursorPage(res, await presenter.present(page.items, req.member), page);
    },
  );
  comments.patch("/:commentId", requireAuth, validate({ params: commentParam, body: editSchema }), async (req, res) => {
    const updated = await service.edit(req.community!, req.member!, String(req.params.commentId), req.body.body);
    sendSuccess(res, await presenter.presentOne(updated, req.member));
  });
  comments.delete("/:commentId", requireAuth, validate({ params: commentParam }), async (req, res) => {
    await service.delete(req.community!, req.member!, String(req.params.commentId));
    sendNoContent(res);
  });
  const like = (on: boolean) => async (req: Request, res: Response) => {
    const c = await service.setLike(req.community!, req.member!, String(req.params.commentId), on);
    sendSuccess(res, { likesCount: c.likesCount, isLiked: on });
  };
  const likeLimit = rateLimit({ limit: 300, windowMs: 3_600_000 });
  comments.put("/:commentId/like", requireAuth, likeLimit, validate({ params: commentParam }), like(true));
  comments.delete("/:commentId/like", requireAuth, likeLimit, validate({ params: commentParam }), like(false));
  comments.post(
    "/:commentId/moderate",
    requireAuth,
    requireRole("moderator"),
    validate({ params: commentParam, body: moderateSchema }),
    async (req, res) => {
      const c = await service.moderate(req.community!, String(req.params.commentId), req.body.action, req.body.reason);
      sendSuccess(res, await presenter.presentOne(c, req.member));
    },
  );

  return { postScoped, comments };
}
