import { Schema, model, type Types } from "mongoose";
import { defineMachine } from "../../core/state/state-machine.js";

export const COMMENT_STATUSES = ["published", "pending", "rejected", "deleted"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

/** Same shape as a post (STATE-MACHINES.md section 3). */
export const commentMachine = defineMachine<CommentStatus>("Comment", {
  published: ["pending", "rejected", "deleted"],
  pending: ["published", "rejected", "deleted"],
  rejected: ["deleted"],
  deleted: [],
});

export interface IComment {
  communityId: Types.ObjectId;
  postId: Types.ObjectId;
  authorId: Types.ObjectId;
  /** The top-level comment of the thread; null for a top-level comment. Replies to replies attach here too (FR-CMT-3). */
  parentId: Types.ObjectId | null;
  /** The member being answered, for the `@name` mention. */
  replyToId?: Types.ObjectId;
  body: string;
  status: CommentStatus;
  heldReason?: "moderation" | "reports";
  removedReason?: string;
  /** An edit waiting for a moderator; the live text stays visible meanwhile. */
  pendingRevision?: { body: string; submittedAt: Date };
  likesCount: number;
  repliesCount: number;
  editedAt?: Date;
  deletedAt?: Date;
  deletedBy?: "author" | "post_author" | "moderator" | "parent" | "account";
  createdAt?: Date;
}

const counter = { type: Number, default: 0, min: 0 };

const commentSchema = new Schema<IComment>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: "Community", required: true },
    postId: { type: Schema.Types.ObjectId, ref: "Post", required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    parentId: { type: Schema.Types.ObjectId, ref: "Comment", default: null },
    replyToId: { type: Schema.Types.ObjectId, ref: "Member" },
    body: { type: String, required: true },
    status: { type: String, enum: COMMENT_STATUSES, required: true },
    heldReason: { type: String, enum: ["moderation", "reports"] },
    removedReason: { type: String, maxlength: 300 },
    pendingRevision: new Schema({ body: String, submittedAt: { type: Date, default: Date.now } }, { _id: false }),
    likesCount: counter,
    repliesCount: counter,
    editedAt: Date,
    deletedAt: Date,
    deletedBy: { type: String, enum: ["author", "post_author", "moderator", "parent", "account"] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

commentSchema.index({ communityId: 1, postId: 1, parentId: 1, status: 1, createdAt: 1, _id: 1 });
commentSchema.index({ communityId: 1, authorId: 1, status: 1 });
commentSchema.index({ communityId: 1, status: 1, createdAt: -1 });

export const CommentModel = model<IComment>("Comment", commentSchema);
