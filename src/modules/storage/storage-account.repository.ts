import type { HydratedDocument } from "mongoose";
import { BaseRepository } from "../../core/base/BaseRepository.js";
import { StorageAccountModel, type IStorageAccount } from "./storage-account.model.js";
import type { AccountStore, AccountView } from "./storage.types.js";

const toView = (doc: HydratedDocument<IStorageAccount>): AccountView => ({
  id: doc.id as string,
  provider: doc.provider,
  encryptedCredentials: doc.credentials,
});

export class StorageAccountRepository extends BaseRepository<IStorageAccount> implements AccountStore {
  /** `headroom` is the fraction of capacity kept free (0.05 = never fill past 95%). */
  constructor(private readonly headroom = 0.05) {
    super(StorageAccountModel);
  }

  /** Single atomic find-and-increment: two concurrent uploads can never both claim the last bytes. */
  async reserveSpace(sizeBytes: number, excludeIds: string[]): Promise<AccountView | null> {
    const doc = await this.model
      .findOneAndUpdate(
        {
          status: "active",
          ...(excludeIds.length > 0 && { _id: { $nin: excludeIds } }),
          $expr: { $lte: [{ $add: ["$usedBytes", sizeBytes] }, { $multiply: ["$capacityBytes", 1 - this.headroom] }] },
        },
        { $inc: { usedBytes: sizeBytes } },
        { sort: { priority: 1, createdAt: 1 }, returnDocument: "after" },
      )
      .select("+credentials")
      .exec();
    return doc ? toView(doc) : null;
  }

  async release(accountId: string, sizeBytes: number): Promise<void> {
    // Pipeline update so the counter can never go negative if accounting drifted. Mongoose 9 requires the explicit
    // `updatePipeline` opt-in for array-style updates.
    await this.model
      .updateOne(
        { _id: accountId },
        [{ $set: { usedBytes: { $max: [0, { $subtract: ["$usedBytes", sizeBytes] }] } } }],
        { updatePipeline: true },
      )
      .exec();
  }

  async markFull(accountId: string): Promise<void> {
    await this.model.updateOne({ _id: accountId, status: "active" }, { status: "full" }).exec();
  }

  async findAccount(accountId: string): Promise<AccountView | null> {
    const doc = await this.model.findById(accountId).select("+credentials").exec();
    return doc ? toView(doc) : null;
  }

  findAllOrdered() {
    return this.model.find().sort({ priority: 1, createdAt: 1 }).exec();
  }

  findByNameWithCredentials(name: string) {
    return this.model.findOne({ name }).select("+credentials").exec();
  }

  /** Credentials included; for admin operations that must talk to the provider. */
  findWithCredentials(accountId: string) {
    return this.model.findById(accountId).select("+credentials").exec();
  }
}
