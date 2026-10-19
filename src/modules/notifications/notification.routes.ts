import { Router } from "express";
import { z } from "zod";
import { validate } from "../../core/middleware/validate.js";
import { cursorQuerySchema } from "../../core/utils/cursor.js";
import { sendCursorPage, sendNoContent, sendSuccess } from "../../core/utils/response.js";
import { toAuthor } from "../members/member.dto.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { NOTIFICATION_TYPES, type INotification } from "./notification.model.js";
import type { NotificationService } from "./notification.service.js";
import type { HydratedDocument } from "mongoose";
import type { IMember } from "../members/member.model.js";

const listQuery = cursorQuerySchema.extend({
  unread: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  type: z.enum(NOTIFICATION_TYPES).optional(),
});
const idParam = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id") });
const patchBody = z
  .object({ read: z.literal(true).optional(), dismissed: z.literal(true).optional() })
  .refine((v) => v.read || v.dismissed);

const toDto = (n: HydratedDocument<INotification>, actors: Map<string, HydratedDocument<IMember>>) => ({
  id: n.id as string,
  type: n.type,
  title: n.title,
  body: n.body,
  read: n.read,
  count: n.count,
  actor: n.actorId ? toAuthor(actors.get(n.actorId.toString())) : null,
  target: n.targetType ? { type: n.targetType, id: n.targetId ?? null, postId: n.postId ?? null } : null,
  createdAt: n.createdAt,
});

export function createNotificationRoutes(service: NotificationService) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth);

  router.get("/", validate({ query: listQuery }), async (req, res) => {
    const { cursor, limit, unread, type } = res.locals.query;
    const page = await service.list(req.member!, { unread, type }, cursor, limit);
    sendCursorPage(
      res,
      page.items.map((n) => toDto(n, page.actors)),
      page,
    );
  });
  router.get("/unread-count", async (req, res) => {
    sendSuccess(res, { count: await service.unreadCount(req.member!) });
  });
  router.post("/read-all", async (req, res) => {
    await service.markAllRead(req.member!);
    sendNoContent(res);
  });
  router.patch("/:id", validate({ params: idParam, body: patchBody }), async (req, res) => {
    if (req.body.dismissed) await service.dismiss(req.member!, String(req.params.id));
    else await service.markRead(req.member!, String(req.params.id));
    sendNoContent(res);
  });
  router.delete("/:id", validate({ params: idParam }), async (req, res) => {
    await service.dismiss(req.member!, String(req.params.id));
    sendNoContent(res);
  });
  return router;
}
