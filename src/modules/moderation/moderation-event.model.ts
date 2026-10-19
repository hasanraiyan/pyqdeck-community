import { Schema, model, type Types } from "mongoose";

/**
 * One row per blocked or held item. It records WHAT happened and WHY, never the content itself, so the audit trail
 * does not become a store of the very material that was rejected.
 */
export interface IModerationEvent {
  communityId?: Types.ObjectId;
  userId?: Types.ObjectId;
  source: string;
  sourceId?: string;
  action: "review" | "reject";
  degraded: boolean;
  escalate: boolean;
  categories: string[];
  scores: Record<string, number>;
  provider: string;
  createdAt?: Date;
}

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

const moderationEventSchema = new Schema<IModerationEvent>({
  communityId: { type: Schema.Types.ObjectId, ref: "Community", index: true },
  userId: { type: Schema.Types.ObjectId, ref: "Member", index: true },
  source: { type: String, required: true, index: true },
  sourceId: { type: String },
  action: { type: String, enum: ["review", "reject"], required: true, index: true },
  degraded: { type: Boolean, default: false },
  escalate: { type: Boolean, default: false, index: true },
  categories: { type: [String], default: [] },
  scores: { type: Schema.Types.Mixed, default: {} },
  provider: { type: String, required: true },
  // Old events expire on their own.
  createdAt: { type: Date, default: Date.now, expires: RETENTION_SECONDS },
});

export const ModerationEventModel = model<IModerationEvent>("ModerationEvent", moderationEventSchema);
