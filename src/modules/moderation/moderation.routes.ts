import { Router } from "express";
import { validate } from "../../core/middleware/validate.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import { ModerationEventController } from "./moderation-event.controller.js";
import { listEventsQuerySchema } from "./moderation.schema.js";

/** Moderators and admins only. */
export function createModerationRoutes(controller = new ModerationEventController()) {
  const router = Router();
  router.use(requireAuth, requireRole("moderator"));
  router.get("/events", validate({ query: listEventsQuerySchema }), controller.list);
  return router;
}
