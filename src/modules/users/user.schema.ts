import { z } from "zod";

/** Only community-owned fields are editable. Username, name and avatar are managed in Clerk. */
export const updateProfileSchema = z
  .object({
    headline: z.string().trim().max(120),
    bio: z.string().trim().max(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

/** Clerk usernames can be longer and contain dashes, so keep this permissive; lookups are lowercased. */
export const usernameParamSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.-]{1,64}$/, "Invalid username"),
});
