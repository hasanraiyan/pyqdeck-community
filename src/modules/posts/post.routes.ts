import { Router, type Request, type Response } from "express";
import { StatusCodes } from "http-status-codes";
import { rateLimit } from "../../core/middleware/rateLimit.js";
import { validate } from "../../core/middleware/validate.js";
import { cursorQuerySchema } from "../../core/utils/cursor.js";
import { sendCursorPage, sendNoContent, sendSuccess } from "../../core/utils/response.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import { idempotencyKeyFrom } from "../idempotency/idempotency.js";
import type { PostPresenter } from "./post.presenter.js";
import {
  authorPostsParamSchema,
  createPostSchema,
  editPostSchema,
  feedQuerySchema,
  moderatePostSchema,
  postIdParamSchema,
} from "./post.schema.js";
import type { PostService } from "./post.service.js";

const HOUR = 3_600_000;

/** Posts, feed, reactions on posts and the moderator queue. Comment routes are added by the comments module. */
export function createPostRoutes(service: PostService, presenter: PostPresenter) {
  const router = Router({ mergeParams: true });
  const idParam = validate({ params: postIdParamSchema });

  router.get("/", validate({ query: feedQuerySchema }), async (req, res) => {
    const page = await service.feed(req.community!, req.member, res.locals.query);
    sendCursorPage(res, await presenter.present(page.items, req.member), page);
  });

  router.post(
    "/",
    requireAuth,
    rateLimit({ limit: 10, windowMs: HOUR }),
    validate({ body: createPostSchema }),
    async (req, res) => {
      const post = await service.create(req.community!, req.member!, {
        ...req.body,
        idempotencyKey: idempotencyKeyFrom(req.get("idempotency-key")),
      });
      sendSuccess(res, await presenter.presentOne(post, req.member), StatusCodes.CREATED);
    },
  );

  // Static paths before /:id.
  router.get(
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

  router.get("/:id", idParam, async (req, res) => {
    const post = await service.get(req.community!, req.member, String(req.params.id));
    sendSuccess(res, await presenter.presentOne(post, req.member));
  });

  router.patch("/:id", requireAuth, validate({ params: postIdParamSchema, body: editPostSchema }), async (req, res) => {
    const post = await service.edit(req.community!, req.member!, String(req.params.id), req.body);
    sendSuccess(res, await presenter.presentOne(post, req.member));
  });

  router.delete("/:id", requireAuth, idParam, async (req, res) => {
    await service.delete(req.community!, req.member!, String(req.params.id));
    sendNoContent(res);
  });

  const reaction = (kind: "like" | "bookmark", on: boolean) => async (req: Request, res: Response) => {
    const args = [req.community!, req.member!, String(req.params.id), on] as const;
    const post = kind === "like" ? await service.setLike(...args) : await service.setBookmark(...args);
    sendSuccess(
      res,
      kind === "like"
        ? { likesCount: post.likesCount, isLiked: on }
        : { bookmarksCount: post.bookmarksCount, isBookmarked: on },
    );
  };
  const reactLimit = rateLimit({ limit: 300, windowMs: HOUR });
  router.put("/:id/like", requireAuth, reactLimit, idParam, reaction("like", true));
  router.delete("/:id/like", requireAuth, reactLimit, idParam, reaction("like", false));
  router.put("/:id/bookmark", requireAuth, reactLimit, idParam, reaction("bookmark", true));
  router.delete("/:id/bookmark", requireAuth, reactLimit, idParam, reaction("bookmark", false));

  const hide = (on: boolean) => async (req: Request, res: Response) => {
    await service.setHidden(req.community!, req.member!, String(req.params.id), on);
    sendNoContent(res);
  };
  router.put("/:id/hide", requireAuth, idParam, hide(true));
  router.delete("/:id/hide", requireAuth, idParam, hide(false));

  router.post(
    "/:id/moderate",
    requireAuth,
    requireRole("moderator"),
    validate({ params: postIdParamSchema, body: moderatePostSchema }),
    async (req, res) => {
      const post = await service.moderate(
        req.community!,
        req.member!,
        String(req.params.id),
        req.body.action,
        req.body.reason,
      );
      sendSuccess(res, await presenter.presentOne(post, req.member));
    },
  );

  return router;
}

/** `/hashtags/trending`, `/members/:username/posts` and `/members/me/bookmarks`, mounted by the community router. */
export function createPostCompanionRoutes(service: PostService, presenter: PostPresenter) {
  const router = Router({ mergeParams: true });

  router.get("/hashtags/trending", async (req, res) => {
    sendSuccess(res, await service.trending(req.community!));
  });

  router.get("/members/me/bookmarks", requireAuth, validate({ query: cursorQuerySchema }), async (req, res) => {
    const { cursor, limit } = res.locals.query;
    const page = await service.bookmarked(req.community!, req.member!, cursor, limit);
    sendCursorPage(res, await presenter.present(page.items, req.member), page);
  });

  router.get(
    "/members/:username/posts",
    validate({ params: authorPostsParamSchema, query: cursorQuerySchema }),
    async (req, res) => {
      const { cursor, limit } = res.locals.query;
      const page = await service.byAuthor(req.community!, req.member, String(req.params.username), cursor, limit);
      sendCursorPage(res, await presenter.present(page.items, req.member), page);
    },
  );

  return router;
}
