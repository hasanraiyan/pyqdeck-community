import { Types } from "mongoose";
import { BaseRepository } from "../../core/base/BaseRepository.js";
import { ModerationEventModel, type IModerationEvent } from "./moderation-event.model.js";
import type { ModerationAudit, ModerationEventInput } from "./moderation.types.js";

export class ModerationEventRepository extends BaseRepository<IModerationEvent> implements ModerationAudit {
  constructor() {
    super(ModerationEventModel);
  }

  async record(event: ModerationEventInput): Promise<void> {
    await this.create({
      ...event,
      communityId:
        event.communityId && Types.ObjectId.isValid(event.communityId)
          ? new Types.ObjectId(event.communityId)
          : undefined,
      userId: event.userId && Types.ObjectId.isValid(event.userId) ? new Types.ObjectId(event.userId) : undefined,
    });
  }

  /** Account deleted: the results stay (anonymous statistics) but the person's text and image links go. */
  async scrubContentOf(memberIds: Array<string | Types.ObjectId>): Promise<number> {
    const result = await this.model
      .updateMany({ userId: { $in: memberIds } }, { $unset: { text: 1, imageUrls: 1 } })
      .exec();
    return result.modifiedCount;
  }
}
