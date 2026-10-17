import { Schema, model } from "mongoose";

export const ACCOUNT_STATUSES = ["active", "full", "disabled"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface IStorageAccount {
  /** Human label, e.g. "cloudinary-2". */
  name: string;
  provider: string;
  /** Encrypted JSON. Hidden by default; load it explicitly with `.select("+credentials")`. */
  credentials: string;
  /** Soft limit we enforce ourselves; keep it at or below the provider's real limit. */
  capacityBytes: number;
  usedBytes: number;
  /** `active` takes new uploads, `full` is set automatically on quota errors, `disabled` is set by an admin. */
  status: AccountStatus;
  /** Lower number is filled first. */
  priority: number;
  lastSyncedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const storageAccountSchema = new Schema<IStorageAccount>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    provider: { type: String, required: true },
    credentials: { type: String, required: true, select: false },
    capacityBytes: { type: Number, required: true, min: 1 },
    usedBytes: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ACCOUNT_STATUSES, default: "active", required: true },
    priority: { type: Number, default: 100 },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true },
);

// Matches the reservation query: active accounts in fill order.
storageAccountSchema.index({ status: 1, priority: 1, createdAt: 1 });

export const StorageAccountModel = model<IStorageAccount>("StorageAccount", storageAccountSchema);
