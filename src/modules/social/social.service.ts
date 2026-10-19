import type { HydratedDocument, Types } from "mongoose";
import { AppError } from "../../core/errors/AppError.js";
import type { Notifier } from "../../core/ports/notifier.js";
import type { IMember } from "../members/member.model.js";
import type { MemberService } from "../members/member.service.js";
import type { BlockRepository, FollowRepository } from "./social.repository.js";

type MemberDoc = HydratedDocument<IMember>;

/** Follow graph and blocking. Every operation is idempotent and keeps the counters equal to the real rows (FR-FLW-4). */
export class SocialService {
  constructor(
    private readonly follows: FollowRepository,
    private readonly blocks: BlockRepository,
    private readonly members: MemberService,
    private readonly notifier: Notifier,
  ) {}

  async follow(actor: MemberDoc, target: MemberDoc) {
    if (actor.id === target.id) throw AppError.badRequest("You cannot follow yourself");
    if (await this.blocks.isBlockedEitherWay(actor.communityId, actor._id, target._id)) {
      // Same answer as an unknown member, so a block cannot be probed for (NFR-SEC-9).
      throw AppError.notFound("Member not found");
    }
    if (!(await this.follows.add(actor.communityId, actor._id, target._id))) return; // already following
    await Promise.all([
      this.members.adjustCounters(actor.communityId, actor._id, { followingCount: 1 }),
      this.members.adjustCounters(actor.communityId, target._id, { followersCount: 1 }),
    ]);
    await this.notifier.notify({
      communityId: actor.communityId.toString(),
      recipientId: target.id,
      actorId: actor.id,
      type: "follow",
      targetType: "member",
      targetId: actor.id,
    });
  }

  async unfollow(actor: MemberDoc, target: MemberDoc) {
    if (!(await this.follows.remove(actor.communityId, actor._id, target._id))) return;
    await Promise.all([
      this.members.adjustCounters(actor.communityId, actor._id, { followingCount: -1 }),
      this.members.adjustCounters(actor.communityId, target._id, { followersCount: -1 }),
    ]);
  }

  isFollowing(actor: MemberDoc, targetId: Types.ObjectId) {
    return this.follows.isFollowing(actor.communityId, actor._id, targetId);
  }

  followedAmong(actor: MemberDoc, ids: Types.ObjectId[]) {
    return this.follows.followedAmong(actor.communityId, actor._id, ids);
  }

  async listFollowers(target: MemberDoc, cursor: string | undefined, limit: number) {
    return this.resolvePage(
      target,
      await this.follows.page(target.communityId, "followers", target._id, cursor, limit),
      "followerId",
    );
  }

  async listFollowing(target: MemberDoc, cursor: string | undefined, limit: number) {
    return this.resolvePage(
      target,
      await this.follows.page(target.communityId, "following", target._id, cursor, limit),
      "followingId",
    );
  }

  /** Blocking removes any follows between the two (TBD-17) and hides each from the other. */
  async block(actor: MemberDoc, target: MemberDoc) {
    if (actor.id === target.id) throw AppError.badRequest("You cannot block yourself");
    await this.blocks.add(actor.communityId, actor._id, target._id);
    const removed = await this.follows.removeBetween(actor.communityId, actor._id, target._id);
    if (removed.aToB) {
      await this.members.adjustCounters(actor.communityId, actor._id, { followingCount: -1 });
      await this.members.adjustCounters(actor.communityId, target._id, { followersCount: -1 });
    }
    if (removed.bToA) {
      await this.members.adjustCounters(actor.communityId, target._id, { followingCount: -1 });
      await this.members.adjustCounters(actor.communityId, actor._id, { followersCount: -1 });
    }
  }

  async unblock(actor: MemberDoc, target: MemberDoc) {
    await this.blocks.remove(actor.communityId, actor._id, target._id);
  }

  async listBlocked(actor: MemberDoc, cursor: string | undefined, limit: number) {
    const page = await this.blocks.blockedBy(actor.communityId, actor._id, cursor, limit);
    const members = await this.members.getByIds(
      actor.communityId,
      page.items.map((b) => b.blockedId),
    );
    const byId = new Map(members.map((m) => [m.id as string, m]));
    return {
      ...page,
      items: page.items.map((b) => byId.get(b.blockedId.toString())).filter((m): m is MemberDoc => Boolean(m)),
    };
  }

  /** Members hidden from the viewer, both ways. Used to filter feeds, comments, search and reactions. */
  hiddenFrom(viewer: MemberDoc) {
    return this.blocks.hiddenFrom(viewer.communityId, viewer._id);
  }

  isBlockedEitherWay(a: MemberDoc, bId: Types.ObjectId) {
    return this.blocks.isBlockedEitherWay(a.communityId, a._id, bId);
  }

  private async resolvePage(
    target: MemberDoc,
    page: Awaited<ReturnType<FollowRepository["page"]>>,
    key: "followerId" | "followingId",
  ) {
    const members = await this.members.getByIds(
      target.communityId,
      page.items.map((f) => f[key]),
    );
    const byId = new Map(members.map((m) => [m.id as string, m]));
    return {
      ...page,
      items: page.items
        .map((f) => byId.get(f[key].toString()))
        .filter((m): m is MemberDoc => m !== undefined && m.status === "active"),
    };
  }
}
