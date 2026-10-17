export const MAX_MEDIA_PER_POST = 8;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MEDIA_FOLDER = "pyqdeck-community/media";

/** Uploads never attached to a post within this window are deleted by the cleanup job. */
export const PENDING_TTL_MS = 60 * 60 * 1000;

/** Format names as providers spell them (Cloudinary `allowed_formats`). Keep in step with ALLOWED_IMAGE_TYPES. */
export const ALLOWED_IMAGE_FORMATS = ["jpg", "png", "webp"];

/**
 * A direct-upload ticket stays valid for up to an hour at the provider, so an unfinished upload is only cleaned up
 * after that, otherwise a late upload could land after we deleted the record and be orphaned forever.
 */
export const UPLOADING_TTL_MS = 65 * 60 * 1000;

/** Tickets reserve storage before any bytes arrive, so cap how many one user can hold open at a time. */
export const MAX_OPEN_UPLOADS_PER_USER = 16;
