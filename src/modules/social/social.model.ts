import { Schema, model, type Types } from "mongoose";

export interface IFollow {
  communityId: Types.ObjectId;
  followerId: Types.ObjectId;
  followingId: Types.ObjectId;
  createdAt?: Date;
}

export interface IBlock {
  communityId: Types.ObjectId;
  blockerId: Types.ObjectId;
  blockedId: Types.ObjectId;
  createdAt?: Date;
}

const ref = (to: string) => ({ type: Schema.Types.ObjectId, ref: to, required: true });

const followSchema = new Schema<IFollow>(
  { communityId: ref("Community"), followerId: ref("Member"), followingId: ref("Member") },
  { timestamps: { createdAt: true, updatedAt: false } },
);
followSchema.index({ communityId: 1, followerId: 1, followingId: 1 }, { unique: true });
followSchema.index({ communityId: 1, followingId: 1, createdAt: -1 });

const blockSchema = new Schema<IBlock>(
  { communityId: ref("Community"), blockerId: ref("Member"), blockedId: ref("Member") },
  { timestamps: { createdAt: true, updatedAt: false } },
);
blockSchema.index({ communityId: 1, blockerId: 1, blockedId: 1 }, { unique: true });
blockSchema.index({ communityId: 1, blockedId: 1 });

export const FollowModel = model<IFollow>("Follow", followSchema);
export const BlockModel = model<IBlock>("Block", blockSchema);
