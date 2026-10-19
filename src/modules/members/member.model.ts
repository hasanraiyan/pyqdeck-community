import { Schema, model, type Types } from "mongoose";
import { MEMBER_ROLES, MEMBER_STATUSES, type MemberRole, type MemberStatus } from "./member.states.js";

/**
 * A person's presence in ONE community: their public persona there (D-10). The same Clerk user has a separate,
 * unlinked membership in every other community (FR-COM-7), so nothing here may reference another community.
 */
export interface IMember {
  communityId: Types.ObjectId;
  accountId: Types.ObjectId;
  username: string;
  displayName: string;
  avatarUrl: string;
  avatarMediaId?: Types.ObjectId;
  coverUrl: string;
  coverMediaId?: Types.ObjectId;
  headline: string;
  bio: string;
  location: string;
  github: string;
  linkedin: string;
  twitter: string;
  website: string;
  skills: string[];
  /** Community-defined academic attributes (college, branch, semester ...), validated per community. */
  attributes: Record<string, unknown>;
  role: MemberRole;
  status: MemberStatus;
  suspendedUntil?: Date;
  suspendedReason?: string;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  upvotesCount: number;
  createdAt?: Date;
}

const counter = { type: Number, default: 0, min: 0 };

const memberSchema = new Schema<IMember>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: "Community", required: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", required: true },
    username: { type: String, required: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, trim: true, maxlength: 80 },
    avatarUrl: { type: String, default: "" },
    avatarMediaId: { type: Schema.Types.ObjectId, ref: "Media" },
    coverUrl: { type: String, default: "" },
    coverMediaId: { type: Schema.Types.ObjectId, ref: "Media" },
    headline: { type: String, default: "", trim: true, maxlength: 120 },
    bio: { type: String, default: "", trim: true, maxlength: 500 },
    location: { type: String, default: "", trim: true, maxlength: 80 },
    github: { type: String, default: "", trim: true, maxlength: 39 },
    linkedin: { type: String, default: "", trim: true, maxlength: 100 },
    twitter: { type: String, default: "", trim: true, maxlength: 15 },
    website: { type: String, default: "", trim: true, maxlength: 2048 },
    skills: { type: [String], default: [] },
    attributes: { type: Schema.Types.Mixed, default: {} },
    role: { type: String, enum: MEMBER_ROLES, default: "member", required: true },
    status: { type: String, enum: MEMBER_STATUSES, default: "active", required: true },
    suspendedUntil: { type: Date },
    suspendedReason: { type: String, maxlength: 300 },
    followersCount: counter,
    followingCount: counter,
    postsCount: counter,
    upvotesCount: counter,
  },
  { timestamps: true, minimize: false },
);

memberSchema.index({ communityId: 1, accountId: 1 }, { unique: true });
memberSchema.index({ communityId: 1, username: 1 }, { unique: true });
memberSchema.index({ communityId: 1, status: 1 });

export const MemberModel = model<IMember>("Member", memberSchema);
