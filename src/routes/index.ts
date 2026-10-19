import { Router } from "express";
import { createCommunityRouter } from "../composition.js";
import { createCommunityAdminRoutes } from "../modules/communities/community.routes.js";
import healthRoutes from "../modules/health/health.routes.js";
import { createPlatformLinkRoutes } from "../modules/links/link.routes.js";
import { createStorageRoutes } from "../modules/storage/storage.routes.js";

const router = Router();

router.use("/health", healthRoutes);

const v1 = Router();
v1.use("/communities/:community", createCommunityRouter());
v1.use("/admin/communities", createCommunityAdminRoutes());
v1.use("/admin/storage", createStorageRoutes());
v1.use("/admin/blocked-domains", createPlatformLinkRoutes());
router.use("/v1", v1);

export default router;
