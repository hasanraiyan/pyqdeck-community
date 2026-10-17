import type { Types } from "mongoose";
import { BaseRepository } from "../../core/base/BaseRepository.js";
import { MediaModel, type IMedia, type MediaStatus } from "./media.model.js";

export class MediaRepository extends BaseRepository<IMedia> {
  constructor() {
    super(MediaModel);
  }

  findPendingOwnedBy(ids: string[], owner: string) {
    return this.model.find({ _id: { $in: ids }, owner, status: "pending" }).exec();
  }

  /** Returns how many were actually claimed; the status filter makes a double-claim impossible. */
  async markAttached(ids: string[], owner: string): Promise<number> {
    const result = await this.model
      .updateMany({ _id: { $in: ids }, owner, status: "pending" }, { status: "attached" })
      .exec();
    return result.modifiedCount;
  }

  findStale(status: MediaStatus, olderThan: Date, limit: number) {
    return this.model
      .find({ status, createdAt: { $lt: olderThan } })
      .limit(limit)
      .exec();
  }

  countByOwnerAndStatus(owner: string, status: MediaStatus) {
    return this.model.countDocuments({ owner, status }).exec();
  }

  /** Flips `uploading` to `pending` exactly once. Null if it was not uploading (e.g. completed by a parallel call). */
  completeUpload(id: string, data: Pick<IMedia, "url" | "size" | "mimeType">) {
    return this.model
      .findOneAndUpdate({ _id: id, status: "uploading" }, { ...data, status: "pending" }, { new: true })
      .exec();
  }

  findByIds(ids: Array<string | Types.ObjectId>) {
    return this.model.find({ _id: { $in: ids } }).exec();
  }
}
