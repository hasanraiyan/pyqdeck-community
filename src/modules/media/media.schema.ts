import { z } from "zod";
import { ALLOWED_IMAGE_TYPES, MAX_FILE_BYTES, MAX_MEDIA_PER_POST } from "./media.constants.js";

export const mediaIdParamSchema = z.object({ id: z.string().min(1) });

/** What the app declares before uploading straight to the provider: type and size only, never bytes. */
export const requestUploadsSchema = z.object({
  files: z
    .array(
      z.object({
        mimeType: z.enum(ALLOWED_IMAGE_TYPES),
        size: z.number().int().min(1).max(MAX_FILE_BYTES),
      }),
    )
    .min(1)
    .max(MAX_MEDIA_PER_POST),
});
