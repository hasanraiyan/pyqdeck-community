import { Types, type HydratedDocument } from "mongoose";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/utils/logger.js";
import { StatusCodes } from "http-status-codes";
import {
  ALLOWED_IMAGE_FORMATS,
  ALLOWED_IMAGE_TYPES,
  MAX_FILE_BYTES,
  MAX_MEDIA_PER_POST,
  MAX_OPEN_UPLOADS_PER_USER,
  MEDIA_FOLDER,
  PENDING_TTL_MS,
  UPLOADING_TTL_MS,
} from "./media.constants.js";
import type { IMedia } from "./media.model.js";
import type { MediaRepository } from "./media.repository.js";
import type {
  Actor,
  DeclaredFile,
  DirectUploadStorage,
  FileStorage,
  FileValidator,
  ImageModerator,
  ModeratedImage,
  UploadedFile,
  UploadTicket,
} from "./media.types.js";

type MediaDoc = HydratedDocument<IMedia>;

const safeFileName = (name: string) =>
  name
    .split(/[\\/]/)
    .pop()!
    .replace(/[^\w.-]/g, "_")
    .slice(0, 80) || "upload";

export class MediaService {
  constructor(
    private readonly repository: MediaRepository,
    private readonly storage: FileStorage & DirectUploadStorage,
    private readonly validator: FileValidator,
    private readonly moderator: ImageModerator,
  ) {}

  /**
   * Blocks anything that is not clearly fine. A moderation outage is a 503 (retry shortly), never a silent pass, so
   * unchecked images cannot slip through while the checker is down.
   */
  private async assertImageAllowed(
    image: ModeratedImage,
    communityId: string,
    userId: string,
    sourceId?: string,
  ): Promise<void> {
    const verdict = await this.moderator.check(image, { communityId, userId, sourceId });
    if (verdict.unavailable) {
      throw AppError.serviceUnavailable("Image checks are temporarily unavailable, please try again shortly");
    }
    if (!verdict.allowed) {
      throw AppError.unprocessable("This image cannot be posted because it may violate our community guidelines");
    }
  }

  /**
   * Direct upload, step 1. The app declares what it will upload (type and size, no bytes). Space is reserved and a
   * signed ticket is returned per file, so the bytes go app -> provider and never through this server.
   */
  async requestUploads(
    communityId: string,
    ownerId: string,
    declared: DeclaredFile[],
  ): Promise<Array<{ media: MediaDoc; ticket: UploadTicket }>> {
    if (declared.length === 0) throw AppError.badRequest("Declare at least one file");
    if (declared.length > MAX_MEDIA_PER_POST)
      throw AppError.badRequest(`At most ${MAX_MEDIA_PER_POST} images are allowed`);
    for (const file of declared) {
      if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.mimeType)) {
        throw AppError.badRequest("Only JPEG, PNG and WebP images are allowed");
      }
      if (file.size < 1) throw AppError.badRequest("Empty file");
      if (file.size > MAX_FILE_BYTES) {
        throw new AppError(
          StatusCodes.REQUEST_TOO_LONG,
          `Each image must be ${MAX_FILE_BYTES / (1024 * 1024)} MB or smaller`,
        );
      }
    }

    // Tickets reserve storage before any bytes exist, so one user must not be able to hold unlimited space.
    const open = await this.repository.countByOwnerAndStatus(ownerId, "uploading");
    if (open + declared.length > MAX_OPEN_UPLOADS_PER_USER) {
      throw AppError.tooManyRequests("Finish your current uploads before starting more");
    }

    const settled = await Promise.allSettled(
      declared.map(async (file) => {
        const { file: reserved, ticket } = await this.storage.createUploadTicket({
          sizeBytes: file.size,
          folder: MEDIA_FOLDER,
          allowedFormats: ALLOWED_IMAGE_FORMATS,
        });
        try {
          const media = await this.repository.create({
            communityId: new Types.ObjectId(communityId),
            owner: new Types.ObjectId(ownerId),
            accountId: new Types.ObjectId(reserved.accountId),
            provider: reserved.provider,
            key: reserved.key,
            mimeType: file.mimeType,
            size: file.size,
            status: "uploading",
          });
          return { media, ticket };
        } catch (err) {
          await this.storage
            .remove(reserved)
            .catch((e) => logger.error({ err: e, key: reserved.key }, "leaked reservation after failed save"));
          throw err;
        }
      }),
    );

    const created = settled
      .filter((r): r is PromiseFulfilledResult<{ media: MediaDoc; ticket: UploadTicket }> => r.status === "fulfilled")
      .map((r) => r.value);
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) {
      await Promise.allSettled(created.map((c) => this.discard(c.media)));
      throw failure.reason;
    }
    return created;
  }

  /**
   * Direct upload, step 2. The app says it finished; we do not take its word. The provider is asked what actually
   * arrived, and anything bigger than declared or not an allowed image is deleted. Safe to call twice.
   */
  async complete(communityId: string, ownerId: string, mediaId: string): Promise<MediaDoc> {
    const media = await this.repository.findById(mediaId);
    // Same 404 for "not yours" and "does not exist" so ids cannot be probed.
    if (!media || media.owner.toString() !== ownerId || media.communityId.toString() !== communityId) {
      throw AppError.notFound("Media not found");
    }
    if (media.status !== "uploading") return media;

    const found = await this.storage.inspect({ accountId: media.accountId.toString(), key: media.key });
    if (!found) throw AppError.conflict("The file has not finished uploading");

    if (found.size > media.size || !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(found.mimeType)) {
      await this.discard(media);
      throw AppError.badRequest("The uploaded file does not match what was declared");
    }

    // The file is already at the provider, so a rejected image must be deleted. A moderation outage must not delete
    // it: the app can simply call complete again once checks are back.
    try {
      await this.assertImageAllowed({ url: found.url }, communityId, ownerId, media.id);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === StatusCodes.UNPROCESSABLE_ENTITY) await this.discard(media);
      throw err;
    }

    const done = await this.repository.completeUpload(media.id, {
      url: found.url,
      size: found.size,
      mimeType: found.mimeType,
    });
    if (!done) {
      // A parallel call completed (or cleanup removed) it first.
      const current = await this.repository.findById(mediaId);
      if (!current) throw AppError.notFound("Media not found");
      return current;
    }
    await this.storage.settle(media.accountId.toString(), media.size, found.size);
    return done;
  }

  /** All-or-nothing: every file is validated before any is stored, and a failure part-way removes what was stored. */
  async upload(communityId: string, ownerId: string, files: UploadedFile[]): Promise<MediaDoc[]> {
    if (files.length === 0) throw AppError.badRequest("No files uploaded");
    if (files.length > MAX_MEDIA_PER_POST)
      throw AppError.badRequest(`At most ${MAX_MEDIA_PER_POST} images are allowed`);

    const validated = await Promise.all(
      files.map(async (file) => ({ file, ...(await this.validator.validate(file.buffer)) })),
    );

    // Checked before anything is stored, so a rejected image never reaches the storage provider at all.
    await Promise.all(
      validated.map(({ file, mimeType }) =>
        this.assertImageAllowed({ data: file.buffer, mimeType }, communityId, ownerId),
      ),
    );

    const settled = await Promise.allSettled(
      validated.map(async ({ file, mimeType }) => {
        const stored = await this.storage.store({
          data: file.buffer,
          fileName: safeFileName(file.originalName),
          mimeType,
          folder: MEDIA_FOLDER,
        });
        try {
          return await this.repository.create({
            communityId: new Types.ObjectId(communityId),
            owner: new Types.ObjectId(ownerId),
            accountId: new Types.ObjectId(stored.accountId),
            provider: stored.provider,
            key: stored.key,
            url: stored.url,
            mimeType,
            size: stored.size,
          });
        } catch (err) {
          // The file is stored but we could not record it: remove it now or it would be orphaned forever.
          await this.storage
            .remove(stored)
            .catch((e) => logger.error({ err: e, key: stored.key }, "orphaned file after failed save"));
          throw err;
        }
      }),
    );

    const created = settled
      .filter((r): r is PromiseFulfilledResult<MediaDoc> => r.status === "fulfilled")
      .map((r) => r.value);
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) {
      await Promise.allSettled(created.map((m) => this.discard(m)));
      throw failure.reason;
    }
    return created;
  }

  /**
   * Called by posts, comments and profiles: claims confirmed uploads so cleanup leaves them alone, and returns their
   * public URLs in the order given.
   */
  async attach(communityId: string, ownerId: string, ids: string[]): Promise<Array<{ id: string; url: string }>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    if (unique.length > MAX_MEDIA_PER_POST) throw AppError.badRequest(`At most ${MAX_MEDIA_PER_POST} images per post`);
    if (!unique.every((id) => Types.ObjectId.isValid(id))) throw AppError.badRequest("Invalid media id");

    const claimable = await this.repository.findPendingOwnedBy(unique, ownerId, communityId);
    if (claimable.length !== unique.length) {
      throw AppError.badRequest("Some images are missing, belong to someone else, or are already used");
    }
    if ((await this.repository.markAttached(unique, ownerId, communityId)) !== unique.length) {
      throw AppError.conflict("Images were claimed by another request");
    }
    const byId = new Map(claimable.map((m) => [m.id as string, m.url]));
    return unique.map((id) => ({ id, url: byId.get(id) ?? "" }));
  }

  /** Public URLs for ids that are already attached (used when rendering content). */
  async urlsFor(ids: string[]): Promise<Array<{ id: string; url: string }>> {
    const docs = await this.repository.findByIds(ids.filter((id) => Types.ObjectId.isValid(id)));
    return docs.map((d) => ({ id: d.id as string, url: d.url }));
  }

  /** Called by the posts module when a post is deleted. Removes the files and their records. */
  async release(ids: string[]): Promise<void> {
    const docs = await this.repository.findByIds(ids);
    await Promise.all(docs.map((d) => this.discard(d)));
  }

  /** Member-facing delete: only unattached uploads. Attached media belongs to its post. */
  async delete(actor: Actor, id: string): Promise<void> {
    const media = await this.repository.findById(id);
    const isStaff = actor.role === "moderator" || actor.role === "admin";
    // Same 404 for "not yours" and "does not exist" so ids cannot be probed.
    if (
      !media ||
      media.communityId.toString() !== actor.communityId ||
      (media.owner.toString() !== actor.id && !isStaff)
    ) {
      throw AppError.notFound("Media not found");
    }
    if (media.status === "attached") throw AppError.conflict("This image is used by a post; delete the post instead");
    await this.discard(media);
  }

  /**
   * Deletes abandoned uploads: confirmed-but-never-used (`pending`) and never-confirmed (`uploading`) ones. One
   * failure never blocks the rest; it is retried on the next run.
   */
  async cleanupExpired(batchSize = 100): Promise<number> {
    const now = Date.now();
    const stale = [
      ...(await this.repository.findStale("pending", new Date(now - PENDING_TTL_MS), batchSize)),
      ...(await this.repository.findStale("uploading", new Date(now - UPLOADING_TTL_MS), batchSize)),
    ];
    let removed = 0;
    for (const media of stale) {
      try {
        await this.discard(media);
        removed++;
      } catch (err) {
        logger.error({ err, mediaId: media.id }, "failed to clean up expired upload");
      }
    }
    return removed;
  }

  /** Storage first, record second: if storage fails the record survives and the delete can be retried. */
  private async discard(media: MediaDoc): Promise<void> {
    await this.storage.remove({ accountId: media.accountId.toString(), key: media.key, size: media.size });
    await this.repository.deleteById(media.id);
  }
}
