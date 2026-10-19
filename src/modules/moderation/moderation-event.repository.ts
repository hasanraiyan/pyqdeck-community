import { Types } from "mongoose";
import { BaseRepository } from "../../core/base/BaseRepository.js";
import { ModerationEventModel, type IModerationEvent } from "./moderation-event.model.js";
import type { ModerationAudit, ModerationEventInput } from "./moderation.types.js";

export class ModerationEventRepository extends BaseRepository<IModerationEvent> implements ModerationAudit {
  constructor() {
    super(ModerationEventModel);
  }

  async record(event: ModerationEventInput): Promise<void> {
    // "allow" is never recorded, so the type narrows to review | reject.
    if (event.action === "allow") return;
    await this.create({
      ...event,
      action: event.action,
      communityId:
        event.communityId && Types.ObjectId.isValid(event.communityId)
          ? new Types.ObjectId(event.communityId)
          : undefined,
      userId: event.userId && Types.ObjectId.isValid(event.userId) ? new Types.ObjectId(event.userId) : undefined,
    });
  }
}
