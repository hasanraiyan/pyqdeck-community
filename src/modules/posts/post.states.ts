import { defineMachine } from "../../core/state/state-machine.js";

export const POST_STATUSES = ["published", "pending", "rejected", "deleted"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Why a post is `pending`; decides what "approve" means and what the author sees. */
export const HELD_REASONS = ["moderation", "reports"] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

/** See STATE-MACHINES.md section 2. A held edit is a `pendingRevision` on a published post, not a state. */
export const postMachine = defineMachine<PostStatus>("Post", {
  published: ["pending", "rejected", "deleted"],
  pending: ["published", "rejected", "deleted"],
  rejected: ["deleted"],
  deleted: [],
});
