import { z } from "zod";
import { paginationQuerySchema } from "../../core/utils/pagination.js";

export const listEventsQuerySchema = paginationQuerySchema.extend({
  action: z.enum(["allow", "review", "reject"]).optional(),
  /** The id of the thing that was checked: a media id for images, a post or comment id for text. */
  sourceId: z.string().trim().min(1).max(64).optional(),
  source: z.string().trim().min(1).max(40).optional(),
  escalate: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  userId: z
    .string()
    .regex(/^[0-9a-f]{24}$/i)
    .optional(),
});
