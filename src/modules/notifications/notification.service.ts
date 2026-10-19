import type { HydratedDocument, Types } from "mongoose";
import { AppError } from "../../core/errors/AppError.js";
import type { Notifier, NotifyInput } from "../../core/ports/notifier.js";
import { logger } from "../../core/utils/logger.js";
import type { IMember } from "../members/member.model.js";
import type { MemberService } from "../members/member.service.js";
import type { INotification } from "./notification.model.js";
import type { NotificationRepository } from "./notification.repository.js";

type MemberDoc = HydratedDocument<IMember>;

/** Likes on one post re-flag the notification as unread at most this often (FR-NTF-3). */
const UPVOTE_REFLAG_MS = 10 * 60 * 1000;

const COPY: Record<INotification["type"], (actor: string) => { title: string; body: string }> = {
  comment: (a) => ({ title: "New comment", body: `${a} commented on your post` }),
  reply: (a) => ({ title: "New reply", body: `${a} replied to your comment` }),
  upvote: (a) => ({ title: "New upvote", body: `${a} upvoted your post` }),
  follow: (a) => ({ title: "New follower", body: `${a} started following you` }),
  moderation: () => ({ title: "Update on your content", body: "" }),
};

export class NotificationService implements Notifier {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly members: MemberService,
  ) {}

  /** Best effort: a failure here is logged, never thrown, so the like or comment that caused it still succeeds. */
  async notify(input: NotifyInput): Promise<void> {
    try {
      if (input.actorId && input.actorId === input.recipientId) return;
      const { communityId, recipientId } = input;

      if (input.type === "upvote" && input.targetId) {
        const existing = await this.repository.findAggregate(communityId, recipientId, input.targetId);
        if (existing) {
          const stale = Date.now() - existing.lastEventAt.getTime() > UPVOTE_REFLAG_MS;
          await this.repository.bumpAggregate(communityId, existing._id, stale);
          return;
        }
      }

      const actor = input.actorId ? (await this.members.getByIds(communityId as never, [input.actorId]))[0] : undefined;
      const copy = COPY[input.type](actor?.displayName ?? "Someone");
      await this.repository.createIn(communityId, {
        recipientId: recipientId as never,
        actorId: input.actorId as never,
        type: input.type,
        targetType: input.targetType,
        targetId: input.targetId,
        postId: input.postId,
        title: input.title ?? copy.title,
        body: input.body ?? copy.body,
      });
    } catch (err) {
      logger.error({ err, type: input.type }, "failed to create notification");
    }
  }

  async removeForTargets(communityId: string, targetType: "post" | "comment" | "member", targetIds: string[]) {
    if (targetIds.length === 0) return;
    try {
      await this.repository.removeForTargets(communityId, targetType, targetIds);
    } catch (err) {
      logger.error({ err }, "failed to remove notifications");
    }
  }

  async list(
    member: MemberDoc,
    filter: { unread?: boolean; type?: INotification["type"] },
    cursor: string | undefined,
    limit: number,
  ) {
    const page = await this.repository.page(member.communityId, member._id, filter, cursor, limit);
    const actorIds = [...new Set(page.items.flatMap((n) => (n.actorId ? [n.actorId.toString()] : [])))];
    const actors = actorIds.length ? await this.members.getByIds(member.communityId, actorIds) : [];
    return { ...page, actors: new Map(actors.map((a) => [a.id as string, a])) };
  }

  unreadCount(member: MemberDoc) {
    return this.repository.countUnread(member.communityId, member._id);
  }

  async markRead(member: MemberDoc, id: string | Types.ObjectId) {
    const updated = await this.repository.markRead(member.communityId, member._id, id);
    if (!updated) throw AppError.notFound("Notification not found");
    return updated;
  }

  async markAllRead(member: MemberDoc) {
    return this.repository.markAllRead(member.communityId, member._id);
  }

  async dismiss(member: MemberDoc, id: string | Types.ObjectId) {
    const updated = await this.repository.dismiss(member.communityId, member._id, id);
    if (!updated) throw AppError.notFound("Notification not found");
  }
}
