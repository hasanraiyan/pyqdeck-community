import { z } from "zod";
import { MEMBER_ROLES } from "./member.states.js";

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

/** Social links are handles, not URLs, so no scheme can slip in (FR-PRF-4). A leading `@` is tolerated. */
const handle = (pattern: RegExp, max: number) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/^@/, ""))
    .pipe(z.string().max(max).regex(pattern, "Invalid handle").or(z.literal("")));

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    if (v === "") return true;
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use a full https:// address");

const attributes = z
  .record(z.string().max(40), z.union([z.string().max(120), z.number(), z.boolean(), z.null()]))
  .refine((v) => Object.keys(v).length <= 20, "Too many attributes");

export const updateMemberSchema = z
  .object({
    username: z.string().trim().toLowerCase().min(3).max(30),
    displayName: z.string().trim().min(1).max(80),
    headline: z.string().trim().max(120),
    bio: z.string().trim().max(500),
    location: z.string().trim().max(80),
    github: handle(/^[A-Za-z0-9-]+$/, 39),
    linkedin: handle(/^[A-Za-z0-9-]{3,100}$/, 100),
    twitter: handle(/^[A-Za-z0-9_]{1,15}$/, 15),
    website: httpsUrl,
    skills: z.array(z.string().trim().min(1).max(30)).max(10),
    attributes,
    avatarMediaId: objectId.nullable(),
    coverMediaId: objectId.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

/** Handles can contain dashes and dots, so keep this permissive; lookups are lowercased. */
export const usernameParamSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.-]{1,64}$/, "Invalid username"),
});

export const searchMembersQuerySchema = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const suspendSchema = z.object({
  reason: z.string().trim().min(1).max(300),
  /** ISO time the suspension ends; omit for open-ended. */
  until: z.coerce.date().min(new Date()).optional(),
});

export const setRoleSchema = z.object({ role: z.enum(MEMBER_ROLES) });
