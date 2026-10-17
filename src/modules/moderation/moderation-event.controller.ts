import { BaseController } from "../../core/base/BaseController.js";
import type { IModerationEvent } from "./moderation-event.model.js";
import { ModerationEventService } from "./moderation-event.service.js";

/** Read-only: only `list` is routed. Events are created by the moderation service, never through the API. */
export class ModerationEventController extends BaseController<IModerationEvent, ModerationEventService> {
  constructor(service = new ModerationEventService()) {
    super(service);
  }
}
