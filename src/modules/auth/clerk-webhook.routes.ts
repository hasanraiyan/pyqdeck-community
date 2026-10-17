import { verifyWebhook } from "@clerk/express/webhooks";
import express, { Router } from "express";
import { StatusCodes } from "http-status-codes";
import { env } from "../../config/env.js";
import { UserService } from "../users/user.service.js";

const router = Router();
const users = new UserService();

/**
 * Clerk -> community user lifecycle sync. POST /api/webhooks/clerk
 *
 * Mounted BEFORE express.json(): Svix signs the exact request bytes, so the body must stay raw. The signature is
 * the authentication here (the caller is Svix, not a signed-in user), which is why it is verified first.
 */
router.post("/clerk", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook(req, { signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET });
  } catch (err) {
    req.log.warn({ err }, "clerk webhook signature verification failed");
    res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: "Webhook verification failed" });
    return;
  }

  // Handlers are idempotent, and a thrown error becomes a 5xx so Svix retries the delivery.
  switch (event.type) {
    case "user.created":
    case "user.updated":
      await users.syncFromClerk(event.data.id);
      break;
    case "user.deleted":
      if (event.data.id) await users.markDeleted(event.data.id);
      break;
  }
  res.status(StatusCodes.OK).json({ success: true, received: true });
});

export default router;
