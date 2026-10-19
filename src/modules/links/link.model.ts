import { Schema, model, type Types } from "mongoose";
import { defineMachine } from "../../core/state/state-machine.js";

export const LINK_STATUSES = ["active", "inactive", "blocked"] as const;
export const LINK_VERDICTS = ["clean", "suspicious", "malicious", "unchecked"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];
export type LinkVerdict = (typeof LINK_VERDICTS)[number];

/** Link status is a projection of its content's state; `blocked` is a moderator override that content cannot undo. */
export const linkMachine = defineMachine<LinkStatus>("Link", {
  inactive: ["active", "blocked"],
  active: ["inactive", "blocked"],
  blocked: ["inactive"],
});

export interface ILink {
  communityId: Types.ObjectId;
  /** Public, random, never reused. */
  code: string;
  contentType: "post" | "comment" | "profile";
  contentId: string;
  normalizedUrl: string;
  host: string;
  verdict: LinkVerdict;
  verdictSource: string;
  checkedAt?: Date;
  status: LinkStatus;
  clicks: number;
  createdBy: Types.ObjectId;
  createdAt?: Date;
}

const linkSchema = new Schema<ILink>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: "Community", required: true },
    code: { type: String, required: true, unique: true },
    contentType: { type: String, enum: ["post", "comment", "profile"], required: true },
    contentId: { type: String, required: true },
    normalizedUrl: { type: String, required: true, maxlength: 2048 },
    host: { type: String, required: true },
    verdict: { type: String, enum: LINK_VERDICTS, default: "unchecked", required: true },
    verdictSource: { type: String, default: "" },
    checkedAt: { type: Date },
    status: { type: String, enum: LINK_STATUSES, default: "inactive", required: true },
    clicks: { type: Number, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "Member", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
linkSchema.index({ communityId: 1, contentType: 1, contentId: 1, normalizedUrl: 1 }, { unique: true });
linkSchema.index({ communityId: 1, host: 1 });

export interface ILinkClickDaily {
  code: string;
  day: string;
  count: number;
}
const clickSchema = new Schema<ILinkClickDaily>({
  code: { type: String, required: true },
  day: { type: String, required: true }, // YYYY-MM-DD, UTC. No IP, no user: counts only.
  count: { type: Number, default: 0 },
});
clickSchema.index({ code: 1, day: 1 }, { unique: true });

export interface IBlockedDomain {
  /** "platform" or a community id. */
  scope: string;
  domain: string;
  reason: string;
  createdBy?: Types.ObjectId;
  createdAt?: Date;
}
const blockedSchema = new Schema<IBlockedDomain>(
  {
    scope: { type: String, required: true },
    domain: { type: String, required: true, lowercase: true, trim: true },
    reason: { type: String, default: "", maxlength: 300 },
    createdBy: { type: Schema.Types.ObjectId, ref: "Member" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
blockedSchema.index({ scope: 1, domain: 1 }, { unique: true });

export const LinkModel = model<ILink>("Link", linkSchema);
export const LinkClickDailyModel = model<ILinkClickDaily>("LinkClickDaily", clickSchema);
export const BlockedDomainModel = model<IBlockedDomain>("BlockedDomain", blockedSchema);
