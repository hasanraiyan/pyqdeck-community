import type { HydratedDocument } from "mongoose";
import type { IUser } from "./user.model.js";

type UserDoc = HydratedDocument<IUser>;

/** Safe to show anyone. Never add email, clerkId or status here. */
export function toPublicProfile(user: UserDoc) {
  return {
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    headline: user.headline,
    bio: user.bio,
    role: user.role,
    createdAt: user.createdAt,
  };
}

/** For the signed-in user's own account only. */
export function toOwnProfile(user: UserDoc) {
  return { ...toPublicProfile(user), id: user.id as string, email: user.email, status: user.status };
}
