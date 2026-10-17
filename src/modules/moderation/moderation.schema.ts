import { z } from "zod";
import { paginationQuerySchema } from "../../core/utils/pagination.js";

export const listEventsQuerySchema = paginationQuerySchema.extend({
  action: z.enum(["review", "reject"]).optional(),
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
