import { verifyWebhook } from "@clerk/express/webhooks";
import express, { Router } from "express";
import { StatusCodes } from "http-status-codes";
import { env } from "../../config/env.js";
import { getServices } from "../../composition.js";
import { getAccountService } from "../accounts/account.module.js";

const router = Router();

/**
 * Clerk -> community account lifecycle sync. POST /api/webhooks/clerk
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

  getServices(); // makes sure the account-deletion listeners are registered
  const accounts = getAccountService();
  // Handlers are idempotent, and a thrown error becomes a 5xx so Svix retries the delivery.
  switch (event.type) {
    case "user.created":
    case "user.updated":
      await accounts.syncFromClerk(event.data.id);
      break;
    case "user.deleted":
      if (event.data.id) await accounts.markDeleted(event.data.id);
      break;
  }
  res.status(StatusCodes.OK).json({ success: true, received: true });
});

export default router;
