import type { Types } from "mongoose";
import { ScopedRepository } from "../../core/base/ScopedRepository.js";
import { cursorCondition, cursorSort, toCursorPage } from "../../core/utils/cursor.js";
import { NotificationModel, type INotification } from "./notification.model.js";

type Id = string | Types.ObjectId;

export class NotificationRepository extends ScopedRepository<INotification> {
  constructor() {
    super(NotificationModel);
  }

  async page(
    communityId: Id,
    recipientId: Id,
    filter: { unread?: boolean; type?: INotification["type"] },
    cursor: string | undefined,
    limit: number,
  ) {
    const rows = await this.findIn(communityId, {
      recipientId,
      dismissed: false,
      ...(filter.unread && { read: false }),
      ...(filter.type && { type: filter.type }),
      ...cursorCondition(cursor, "desc"),
    } as never)
      .sort(cursorSort("desc"))
      .limit(limit + 1)
      .exec();
    return toCursorPage(rows, limit);
  }

  countUnread(communityId: Id, recipientId: Id) {
    return this.countIn(communityId, { recipientId, read: false, dismissed: false } as never);
  }

  findAggregate(communityId: Id, recipientId: Id, targetId: string) {
    return this.findOneIn(communityId, {
      recipientId,
      type: "upvote",
      targetType: "post",
      targetId,
      dismissed: false,
    } as never);
  }

  bumpAggregate(communityId: Id, id: Id, reflagAsUnread: boolean) {
    return this.updateOneIn(
      communityId,
      { _id: id } as never,
      { $inc: { count: 1 }, ...(reflagAsUnread && { $set: { read: false, lastEventAt: new Date() } }) } as never,
    );
  }

  markRead(communityId: Id, recipientId: Id, id: Id) {
    return this.updateOneIn(communityId, { _id: id, recipientId } as never, { read: true } as never);
  }

  markAllRead(communityId: Id, recipientId: Id) {
    return this.updateManyIn(communityId, { recipientId, read: false } as never, { read: true } as never);
  }

  dismiss(communityId: Id, recipientId: Id, id: Id) {
    return this.updateOneIn(communityId, { _id: id, recipientId } as never, { dismissed: true, read: true } as never);
  }

  removeForTargets(communityId: Id, targetType: string, targetIds: string[]) {
    // Moderation outcomes stay: they explain what happened even after the content is gone.
    return this.deleteManyIn(communityId, {
      targetType,
      targetId: { $in: targetIds },
      type: { $ne: "moderation" },
    } as never);
  }
}
