import { Schema, model, type Types } from "mongoose";

/** One collection for every "member marks a target" relation: likes, bookmarks and hidden posts. */
export const REACTION_KINDS = ["post_like", "comment_like", "bookmark", "hide"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

export interface IReaction {
  communityId: Types.ObjectId;
  memberId: Types.ObjectId;
  kind: ReactionKind;
  targetId: Types.ObjectId;
  createdAt?: Date;
}

const reactionSchema = new Schema<IReaction>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: "Community", required: true },
    memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    kind: { type: String, enum: REACTION_KINDS, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// At most one of each kind per member and target, even under concurrent requests (FR-REACT-1).
reactionSchema.index({ communityId: 1, kind: 1, memberId: 1, targetId: 1 }, { unique: true });
reactionSchema.index({ communityId: 1, kind: 1, memberId: 1, createdAt: -1 });

export const ReactionModel = model<IReaction>("Reaction", reactionSchema);
