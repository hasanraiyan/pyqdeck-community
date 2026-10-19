import { randomBytes } from "node:crypto";
import { BaseRepository } from "../../core/base/BaseRepository.js";
import { AccountModel, type IAccount } from "./account.model.js";

export class AccountRepository extends BaseRepository<IAccount> {
  constructor() {
    super(AccountModel);
  }

  findByClerkId(clerkId: string) {
    return this.findOne({ clerkId });
  }

  updateByClerkId(clerkId: string, update: Record<string, unknown>) {
    return this.model.findOneAndUpdate({ clerkId }, update, { returnDocument: "after" }).exec();
  }

  /** Scrubs personal data in place. The row stays so memberships and content keep a valid reference. */
  markDeleted(clerkId: string) {
    return this.model
      .findOneAndUpdate(
        { clerkId, status: { $ne: "deleted" } },
        {
          status: "deleted",
          email: `deleted+${randomBytes(6).toString("hex")}@invalid.local`,
          platformRole: "none",
          clerkProfile: { username: null, displayName: "Deleted user", avatarUrl: "" },
        },
        { returnDocument: "after" },
      )
      .exec();
  }
}
