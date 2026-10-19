import { Schema, model, type Types } from "mongoose";

/**
 * One row per content check: who, where, the result and why, plus a snapshot of what was checked so a moderator can see
 * what the result was about (text, image links). The snapshot is kept for the retention window only, is dropped when the
 * person's account is deleted, and is NEVER kept for `escalate` events (child safety), which must not be copied around.
 */
export interface IModerationEvent {
  communityId?: Types.ObjectId;
  userId?: Types.ObjectId;
  source: string;
  sourceId?: string;
  action: "allow" | "review" | "reject";
  degraded: boolean;
  escalate: boolean;
  categories: string[];
  scores: Record<string, number>;
  provider: string;
  /** The checked text, cut to `MAX_SNAPSHOT_CHARS`. */
  text?: string;
  /** Links to the checked images. A refused image is deleted from storage, so its link no longer opens. */
  imageUrls?: string[];
  createdAt?: Date;
}

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

const moderationEventSchema = new Schema<IModerationEvent>({
  communityId: { type: Schema.Types.ObjectId, ref: "Community", index: true },
  userId: { type: Schema.Types.ObjectId, ref: "Member", index: true },
  source: { type: String, required: true, index: true },
  sourceId: { type: String },
  action: { type: String, enum: ["allow", "review", "reject"], required: true, index: true },
  degraded: { type: Boolean, default: false },
  escalate: { type: Boolean, default: false, index: true },
  categories: { type: [String], default: [] },
  scores: { type: Schema.Types.Mixed, default: {} },
  provider: { type: String, required: true },
  text: { type: String },
  imageUrls: { type: [String], default: undefined },
  // Old events expire on their own.
  createdAt: { type: Date, default: Date.now, expires: RETENTION_SECONDS },
});

export const ModerationEventModel = model<IModerationEvent>("ModerationEvent", moderationEventSchema);
