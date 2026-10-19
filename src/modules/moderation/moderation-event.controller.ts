import type { Request, Response } from "express";
import { BaseController } from "../../core/base/BaseController.js";
import { sendPaginated } from "../../core/utils/response.js";
import type { IModerationEvent } from "./moderation-event.model.js";
import { ModerationEventService } from "./moderation-event.service.js";

/** Read-only: only `list` is routed. Events are created by the moderation service, never through the API. */
export class ModerationEventController extends BaseController<IModerationEvent, ModerationEventService> {
  constructor(service = new ModerationEventService()) {
    super(service);
  }

  /** Moderators only ever see their own community's events (FR-COM-14). */
  override list = async (req: Request, res: Response) => {
    const { page, limit, sort, ...filter } = res.locals.query;
    const { items, pagination } = await this.service.list(
      { ...filter, communityId: req.community!._id },
      { page, limit, sort },
    );
    sendPaginated(res, items, pagination);
  };
}
