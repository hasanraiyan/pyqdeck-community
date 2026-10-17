import { Router } from "express";
import { validate } from "../../core/middleware/validate.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { MediaController } from "./media.controller.js";
import { getMediaService } from "./media.module.js";
import { mediaIdParamSchema, requestUploadsSchema } from "./media.schema.js";
import type { MediaService } from "./media.service.js";
import { uploadImages } from "./upload.middleware.js";

export function createMediaRoutes(service: MediaService = getMediaService()) {
  const router = Router();
  const controller = new MediaController(service);

  // Preferred: the app uploads straight to the storage provider with a signed ticket, then confirms.
  router.post("/uploads", requireAuth, validate({ body: requestUploadsSchema }), controller.requestUploads);
  router.post("/:id/complete", requireAuth, validate({ params: mediaIdParamSchema }), controller.complete);

  // Fallback: bytes pass through this server. Kept for providers or clients without direct upload.
  router.post("/", requireAuth, uploadImages, controller.upload);

  router.delete("/:id", requireAuth, validate({ params: mediaIdParamSchema }), controller.remove);

  return router;
}
