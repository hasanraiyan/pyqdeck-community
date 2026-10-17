import { Schema, model } from "mongoose";

export const USER_ROLES = ["member", "moderator", "admin"] as const;
export const USER_STATUSES = ["active", "suspended", "deleted"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];

/** Community profile. Identity lives in Clerk; this is the community-side record keyed by `clerkId`. */
export interface IUser {
  clerkId: string;
  /** Private: never include in public profile responses. */
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  headline: string;
  bio: string;
  role: UserRole;
  status: UserStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

const userSchema = new Schema<IUser>(
  {
    clerkId: { type: String, required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, trim: true, maxlength: 80 },
    avatarUrl: { type: String, default: "" },
    headline: { type: String, default: "", trim: true, maxlength: 120 },
    bio: { type: String, default: "", trim: true, maxlength: 500 },
    role: { type: String, enum: USER_ROLES, default: "member", required: true },
    status: { type: String, enum: USER_STATUSES, default: "active", required: true },
  },
  { timestamps: true },
);

export const UserModel = model<IUser>("User", userSchema);
