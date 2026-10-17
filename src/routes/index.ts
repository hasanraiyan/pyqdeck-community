import { Router } from "express";
import healthRoutes from "../modules/health/health.routes.js";
import { createMediaRoutes } from "../modules/media/media.routes.js";
import { createModerationRoutes } from "../modules/moderation/moderation.routes.js";
import { createStorageRoutes } from "../modules/storage/storage.routes.js";
import userRoutes from "../modules/users/user.routes.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/users", userRoutes);
router.use("/media", createMediaRoutes());
router.use("/moderation", createModerationRoutes());
router.use("/admin/storage", createStorageRoutes());

export default router;
