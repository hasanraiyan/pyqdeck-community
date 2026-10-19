import { z } from "zod";
import { COMMUNITY_STATUSES } from "./community.states.js";

const slug = z
  .string()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,23}$/, "Use 2-24 lowercase letters, digits or dashes, starting with a letter");

const limits = z
  .object({
    postMaxChars: z.number().int().min(1).max(20000),
    commentMaxChars: z.number().int().min(1).max(5000),
    maxImagesPerPost: z.number().int().min(0).max(8),
    maxLinksPerPost: z.number().int().min(0).max(20),
    maxLinksPerComment: z.number().int().min(0).max(20),
  })
  .partial()
  .strict();

export const slugParamSchema = z.object({ slug });

export const createCommunitySchema = z.object({
  slug,
  name: z.string().trim().min(1).max(80),
  limits: limits.optional(),
});

export const updateCommunitySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    limits,
    profileSchema: z.record(z.string(), z.unknown()),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field");

export const setStatusSchema = z.object({ status: z.enum(COMMUNITY_STATUSES) });
