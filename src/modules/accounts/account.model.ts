import { Schema, model } from "mongoose";

export const PLATFORM_ROLES = ["none", "admin"] as const;
export const ACCOUNT_STATUSES = ["active", "deleted"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * One per Clerk user, across every community. Private: never returned by any endpoint. Memberships (the public,
 * per-community personas) are separate and deliberately unlinked from each other.
 */
export interface IAccount {
  clerkId: string;
  email: string;
  platformRole: PlatformRole;
  status: (typeof ACCOUNT_STATUSES)[number];
  /** Clerk identity at last sync. Only used to prefill a new membership (D-10); never shown. */
  clerkProfile: { username: string | null; displayName: string; avatarUrl: string };
  createdAt?: Date;
}

const accountSchema = new Schema<IAccount>(
  {
    clerkId: { type: String, required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    platformRole: { type: String, enum: PLATFORM_ROLES, default: "none", required: true },
    status: { type: String, enum: ACCOUNT_STATUSES, default: "active", required: true },
    clerkProfile: {
      username: { type: String, default: null },
      displayName: { type: String, default: "" },
      avatarUrl: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

export const AccountModel = model<IAccount>("Account", accountSchema);
