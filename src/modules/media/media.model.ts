import { Schema, model, type Types } from "mongoose";

export const MEDIA_STATUSES = ["uploading", "pending", "attached", "rejected"] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** A stored file. Posts reference this record, never a raw URL, so files can move between storage accounts. */
export interface IMedia {
  communityId: Types.ObjectId;
  /** The uploading member. Membership ids are per community, so ownership already implies the community. */
  owner: Types.ObjectId;
  accountId: Types.ObjectId;
  provider: string;
  key: string;
  url: string;
  mimeType: string;
  size: number;
  /**
   * `uploading`: space reserved and a ticket issued, bytes not yet confirmed. `pending`: confirmed, waiting for a
   * post to claim it. `attached`: used by a post. `rejected`: refused by moderation, kept for a few days for
   * moderators to review and never usable. Stale `uploading`, `pending` and `rejected` records are cleaned up.
   */
  status: MediaStatus;
  createdAt?: Date;
}

const mediaSchema = new Schema<IMedia>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: "Community", required: true },
    owner: { type: Schema.Types.ObjectId, ref: "Member", required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: "StorageAccount", required: true },
    provider: { type: String, required: true },
    key: { type: String, required: true },
    url: { type: String, default: "" }, // unknown until a direct upload is confirmed
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    status: { type: String, enum: MEDIA_STATUSES, default: "pending", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Serves the cleanup scan for stale pending uploads.
mediaSchema.index({ status: 1, createdAt: 1 });

export const MediaModel = model<IMedia>("Media", mediaSchema);
