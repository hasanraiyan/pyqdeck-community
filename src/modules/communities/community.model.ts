import { Schema, model } from "mongoose";
import { COMMUNITY_STATUSES, type CommunityStatus } from "./community.states.js";

/** Per-community limits. Unset values fall back to `DEFAULT_LIMITS` (FR-COM-5). */
export interface CommunityLimits {
  postMaxChars: number;
  commentMaxChars: number;
  maxImagesPerPost: number;
  maxLinksPerPost: number;
  maxLinksPerComment: number;
}

export const DEFAULT_LIMITS: CommunityLimits = {
  postMaxChars: 5000,
  commentMaxChars: 1000,
  maxImagesPerPost: 8, // platform ceiling (D-8); a community may only lower it
  maxLinksPerPost: 5,
  maxLinksPerComment: 3,
};

export interface ICommunity {
  slug: string;
  name: string;
  status: CommunityStatus;
  limits: Partial<CommunityLimits>;
  /** Free-form per-community profile schema and reference data (TBD-20). Stored and returned, not interpreted yet. */
  profileSchema?: Record<string, unknown>;
  createdAt?: Date;
}

const communitySchema = new Schema<ICommunity>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z][a-z0-9-]{1,23}$/ },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    status: { type: String, enum: COMMUNITY_STATUSES, default: "active", required: true },
    limits: { type: Schema.Types.Mixed, default: {} },
    profileSchema: { type: Schema.Types.Mixed },
  },
  { timestamps: true, minimize: false },
);

export const CommunityModel = model<ICommunity>("Community", communitySchema);

export const limitsOf = (community: Pick<ICommunity, "limits">): CommunityLimits => {
  const merged = { ...DEFAULT_LIMITS, ...community.limits };
  merged.maxImagesPerPost = Math.min(merged.maxImagesPerPost, DEFAULT_LIMITS.maxImagesPerPost);
  return merged;
};
