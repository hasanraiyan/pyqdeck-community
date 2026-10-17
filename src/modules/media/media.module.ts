import { getStorageService } from "../storage/storage.module.js";
import { ImageValidator } from "./image-validator.js";
import { MediaCleanupJob } from "./media.cleanup-job.js";
import { MediaRepository } from "./media.repository.js";
import { MediaService } from "./media.service.js";

/** Composition root for media: wires the storage module in as the `FileStorage` port. */
let service: MediaService | undefined;
export const getMediaService = () =>
  (service ??= new MediaService(new MediaRepository(), getStorageService(), new ImageValidator()));

export const createMediaCleanupJob = () => new MediaCleanupJob(getMediaService());
