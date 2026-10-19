import { z } from "zod";
import { cursorQuerySchema } from "../../core/utils/cursor.js";

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

const linkedResource = z.object({
  type: z.enum(["pyq", "topic"]),
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().trim().max(200).optional(),
  subjectId: z.string().max(100).optional(),
  semesterId: z.string().max(100).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  questionId: z.string().max(100).optional(),
  topicId: z.string().max(100).optional(),
});

/** Length limits are per community and enforced by the service; these are only sanity ceilings. */
export const createPostSchema = z.object({
  body: z.string().max(20000).optional(),
  mediaIds: z.array(objectId).max(8).optional(),
  linkedResource: linkedResource.optional(),
});

export const editPostSchema = z
  .object({
    body: z.string().max(20000),
    mediaIds: z.array(objectId).max(8),
    linkedResource: linkedResource.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");

/** Same rules as the app's own search guard: 2-100 characters with at least one letter or digit (FR-SRCH-2). */
const searchText = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine((v) => /[\p{L}\p{N}]/u.test(v), "Search needs at least one letter or digit");

export const feedQuerySchema = cursorQuerySchema.extend({
  hashtag: z
    .string()
    .trim()
    .regex(/^#?[A-Za-z0-9_-]{1,50}$/)
    .optional(),
  q: searchText.optional(),
});

export const postIdParamSchema = z.object({ id: z.string().trim().min(1).max(120) });

export const moderatePostSchema = z.object({
  action: z.enum(["approve", "remove", "reject_edit"]),
  reason: z.enum(["spam", "harassment", "hate", "sexual", "violence", "misinformation", "other"]).optional(),
});

export const authorPostsParamSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.-]{1,64}$/),
});
