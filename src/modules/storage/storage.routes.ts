import { Router } from "express";
import { validate } from "../../core/middleware/validate.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import { StorageAdminController } from "./storage-admin.controller.js";
import type { StorageAdminService } from "./storage-admin.service.js";
import { getStorageAdminService } from "./storage.module.js";
import { accountIdParamSchema, createAccountSchema, updateAccountSchema } from "./storage.schema.js";

/** Admin-only. `requireRole()` with no roles lets only admins through. */
export function createStorageRoutes(service: StorageAdminService = getStorageAdminService()) {
  const router = Router();
  const controller = new StorageAdminController(service);

  router.use(requireAuth, requireRole());
  router.get("/providers", controller.providers);
  router.get("/accounts", controller.list);
  router.post("/accounts", validate({ body: createAccountSchema }), controller.add);
  router.patch(
    "/accounts/:id",
    validate({ params: accountIdParamSchema, body: updateAccountSchema }),
    controller.update,
  );
  router.post("/accounts/:id/refresh-usage", validate({ params: accountIdParamSchema }), controller.refreshUsage);

  return router;
}
