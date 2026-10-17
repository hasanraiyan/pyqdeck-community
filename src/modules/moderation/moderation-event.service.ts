import { BaseService } from "../../core/base/BaseService.js";
import type { IModerationEvent } from "./moderation-event.model.js";
import { ModerationEventRepository } from "./moderation-event.repository.js";

export class ModerationEventService extends BaseService<IModerationEvent, ModerationEventRepository> {
  constructor(repository = new ModerationEventRepository()) {
    super(repository, "Moderation event");
  }
}
