import { Router } from "express";
import { validate } from "../../core/middleware/validate.js";
import { requireAuth } from "../auth/auth.middleware.js";
import { UserController } from "./user.controller.js";
import { updateProfileSchema, usernameParamSchema } from "./user.schema.js";

const router = Router();
const controller = new UserController();

// Static paths first so they are not captured by /:username.
router.get("/me", requireAuth, controller.me);
router.patch("/me", requireAuth, validate({ body: updateProfileSchema }), controller.updateMe);
router.get("/:username", validate({ params: usernameParamSchema }), controller.getByUsername);

export default router;
