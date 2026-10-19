import type { Types } from "mongoose";
import { ScopedRepository } from "../../core/base/ScopedRepository.js";
import { cursorCondition, cursorSort, toCursorPage, type Direction } from "../../core/utils/cursor.js";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";
import { BlockModel, FollowModel, type IBlock, type IFollow } from "./social.model.js";

type Id = string | Types.ObjectId;

export class FollowRepository extends ScopedRepository<IFollow> {
  constructor() {
    super(FollowModel);
  }

  /** True only when this call created the relationship, so counters are bumped exactly once. */
  async add(communityId: Id, followerId: Id, followingId: Id): Promise<boolean> {
    try {
      await this.createIn(communityId, { followerId: followerId as never, followingId: followingId as never });
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  async remove(communityId: Id, followerId: Id, followingId: Id): Promise<boolean> {
    return (await this.deleteManyIn(communityId, { followerId, followingId } as never)) > 0;
  }

  async isFollowing(communityId: Id, followerId: Id, followingId: Id) {
    return (await this.existsIn(communityId, { followerId, followingId } as never)) !== null;
  }

  async followedAmong(communityId: Id, followerId: Id, ids: Id[]): Promise<Set<string>> {
    const rows = await this.findIn(communityId, { followerId, followingId: { $in: ids } } as never)
      .select("followingId")
      .lean()
      .exec();
    return new Set(rows.map((r) => r.followingId.toString()));
  }

  async page(
    communityId: Id,
    side: "followers" | "following",
    memberId: Id,
    cursor: string | undefined,
    limit: number,
  ) {
    const direction: Direction = "desc";
    const filter = side === "followers" ? { followingId: memberId } : { followerId: memberId };
    const rows = await this.findIn(communityId, { ...filter, ...cursorCondition(cursor, direction) } as never)
      .sort(cursorSort(direction))
      .limit(limit + 1)
      .exec();
    return toCursorPage(rows, limit);
  }

  /** Removes both directions between two members; returns how many of each existed, for the counters. */
  async removeBetween(communityId: Id, a: Id, b: Id) {
    const aToB = await this.remove(communityId, a, b);
    const bToA = await this.remove(communityId, b, a);
    return { aToB, bToA };
  }
}

export class BlockRepository extends ScopedRepository<IBlock> {
  constructor() {
    super(BlockModel);
  }

  async add(communityId: Id, blockerId: Id, blockedId: Id): Promise<boolean> {
    try {
      await this.createIn(communityId, { blockerId: blockerId as never, blockedId: blockedId as never });
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  async remove(communityId: Id, blockerId: Id, blockedId: Id) {
    return (await this.deleteManyIn(communityId, { blockerId, blockedId } as never)) > 0;
  }

  /** Everyone the member blocked plus everyone who blocked them: hidden from each other both ways (FR-BLK-1). */
  async hiddenFrom(communityId: Id, memberId: Id): Promise<Types.ObjectId[]> {
    const rows = await this.findIn(communityId, { $or: [{ blockerId: memberId }, { blockedId: memberId }] } as never)
      .lean()
      .exec();
    const me = memberId.toString();
    return rows.map((r) => (r.blockerId.toString() === me ? r.blockedId : r.blockerId));
  }

  async isBlockedEitherWay(communityId: Id, a: Id, b: Id) {
    return (
      (await this.existsIn(communityId, {
        $or: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      } as never)) !== null
    );
  }

  async blockedBy(communityId: Id, blockerId: Id, cursor: string | undefined, limit: number) {
    const direction: Direction = "desc";
    const rows = await this.findIn(communityId, { blockerId, ...cursorCondition(cursor, direction) } as never)
      .sort(cursorSort(direction))
      .limit(limit + 1)
      .exec();
    return toCursorPage(rows, limit);
  }
}
