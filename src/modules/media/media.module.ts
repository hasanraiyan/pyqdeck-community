import { getModerationService } from "../moderation/moderation.module.js";
import { getStorageService } from "../storage/storage.module.js";
import { ImageValidator } from "./image-validator.js";
import { MediaCleanupJob } from "./media.cleanup-job.js";
import { MediaRepository } from "./media.repository.js";
import { MediaService } from "./media.service.js";
import type { ImageModerator } from "./media.types.js";

/** Adapts the moderation module to the small port media defines. Media itself never imports moderation. */
const imageModerator: ImageModerator = {
  async check(image, context) {
    const decision = await getModerationService().moderate({ images: [image] }, { source: "media", ...context });
    return { allowed: decision.action === "allow", unavailable: decision.degraded };
  },
};

/** Composition root for media: wires the storage and moderation modules in as ports. */
let service: MediaService | undefined;
export const getMediaService = () =>
  (service ??= new MediaService(new MediaRepository(), getStorageService(), new ImageValidator(), imageModerator));

export const createMediaCleanupJob = () => new MediaCleanupJob(getMediaService());
