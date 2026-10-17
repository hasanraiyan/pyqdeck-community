import { z } from "zod";
import { ACCOUNT_STATUSES } from "./storage-account.model.js";

const GB = 1024 ** 3;

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(60),
  provider: z.string().trim().min(1),
  /** Validated against the chosen provider's own schema in the service. */
  credentials: z.record(z.string(), z.unknown()),
  /** Soft limit we enforce. Keep it a little below the provider's real limit. */
  capacityBytes: z
    .number()
    .int()
    .min(1)
    .max(1024 * GB),
  priority: z.number().int().min(0).max(10_000).optional(),
});

export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    priority: z.number().int().min(0).max(10_000),
    capacityBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * GB),
    // "full" is reserved for the system; an admin only opens or closes an account.
    status: z.enum(ACCOUNT_STATUSES).exclude(["full"]),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const accountIdParamSchema = z.object({ id: z.string().min(1) });
