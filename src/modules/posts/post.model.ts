import { Schema, model, type Types } from "mongoose";
import { HELD_REASONS, POST_STATUSES, type HeldReason, type PostStatus } from "./post.states.js";

export interface LinkedResource {
  type: "pyq" | "topic";
  title: string;
  subtitle?: string;
  subjectId?: string;
  semesterId?: string;
  year?: number;
  questionId?: string;
  topicId?: string;
}

export interface PostMedia {
  id: Types.ObjectId;
  url: string;
}

/** The content of a post that can be edited. A held edit stores a full replacement of these fields. */
export interface PostContent {
  body: string;
  hashtags: string[];
  hashtagsLower: string[];
  media: PostMedia[];
  linkedResource?: LinkedResource;
}

export interface IPost extends PostContent {
  communityId: Types.ObjectId;
  authorId: Types.ObjectId;
  slug: string;
  status: PostStatus;
  heldReason?: HeldReason;
  removedReason?: string;
  /** An edit waiting for a moderator; the live content above stays visible meanwhile (FR-POST-11). */
  pendingRevision?: PostContent & { submittedAt: Date };
  likesCount: number;
  commentsCount: number;
  bookmarksCount: number;
  editedAt?: Date;
  deletedAt?: Date;
  deletedBy?: "author" | "account";
  createdAt?: Date;
  updatedAt?: Date;
}

const mediaSchema = new Schema<PostMedia>(
  { id: { type: Schema.Types.ObjectId, required: true }, url: String },
  { _id: false },
);

const linkedResourceSchema = new Schema<LinkedResource>(
  {
    type: { type: String, enum: ["pyq", "topic"], required: true },
    title: { type: String, required: true, maxlength: 200 },
    subtitle: { type: String, maxlength: 200 },
    subjectId: String,
    semesterId: String,
    year: Number,
    questionId: String,
    topicId: String,
  },
  { _id: false },
);

const contentFields = {
  body: { type: String, default: "" },
  hashtags: { type: [String], default: [] },
  hashtagsLower: { type: [String], default: [] },
  media: { type: [mediaSchema], default: [] },
  linkedResource: { type: linkedResourceSchema },
};

const counter = { type: Number, default: 0, min: 0 };

const postSchema = new Schema<IPost>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: "Community", required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    slug: { type: String, required: true, immutable: true },
    ...contentFields,
    status: { type: String, enum: POST_STATUSES, required: true },
    heldReason: { type: String, enum: HELD_REASONS },
    removedReason: { type: String, maxlength: 300 },
    pendingRevision: new Schema({ ...contentFields, submittedAt: { type: Date, default: Date.now } }, { _id: false }),
    likesCount: counter,
    commentsCount: counter,
    bookmarksCount: counter,
    editedAt: Date,
    deletedAt: Date,
    deletedBy: { type: String, enum: ["author", "account"] },
  },
  { timestamps: true },
);

postSchema.index({ communityId: 1, slug: 1 }, { unique: true });
postSchema.index({ communityId: 1, status: 1, createdAt: -1, _id: -1 });
postSchema.index({ communityId: 1, status: 1, hashtagsLower: 1, createdAt: -1 });
postSchema.index({ communityId: 1, authorId: 1, status: 1, createdAt: -1 });
// Purge job: soft-deleted rows older than the retention window.
postSchema.index({ status: 1, deletedAt: 1 });
postSchema.index({ communityId: 1, body: "text", hashtagsLower: "text" });

export const PostModel = model<IPost>("Post", postSchema);
