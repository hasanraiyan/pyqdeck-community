import { Schema, model, type Types } from "mongoose";

export const NOTIFICATION_TYPES = ["comment", "reply", "upvote", "follow", "moderation"] as const;
export const NOTIFICATION_TARGETS = ["post", "comment", "member"] as const;

export interface INotification {
  communityId: Types.ObjectId;
  recipientId: Types.ObjectId;
  actorId?: Types.ObjectId;
  type: (typeof NOTIFICATION_TYPES)[number];
  targetType?: (typeof NOTIFICATION_TARGETS)[number];
  targetId?: string;
  postId?: string;
  title: string;
  body: string;
  read: boolean;
  dismissed: boolean;
  /** Upvotes are aggregated into one row per post ("received N new upvotes", FR-NTF-3). */
  count: number;
  /** When the row last changed meaning; likes only re-flag it as unread every 10 minutes. */
  lastEventAt: Date;
  createdAt?: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: "Community", required: true },
    recipientId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "Member" },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    targetType: { type: String, enum: NOTIFICATION_TARGETS },
    targetId: { type: String },
    postId: { type: String },
    title: { type: String, default: "", maxlength: 200 },
    body: { type: String, default: "", maxlength: 500 },
    read: { type: Boolean, default: false },
    dismissed: { type: Boolean, default: false },
    count: { type: Number, default: 1, min: 1 },
    lastEventAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

notificationSchema.index({ communityId: 1, recipientId: 1, createdAt: -1 });
notificationSchema.index({ communityId: 1, targetType: 1, targetId: 1 });

export const NotificationModel = model<INotification>("Notification", notificationSchema);
