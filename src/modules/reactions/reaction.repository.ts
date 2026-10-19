import type { Types } from "mongoose";
import { ScopedRepository } from "../../core/base/ScopedRepository.js";
import { cursorCondition, cursorSort, toCursorPage } from "../../core/utils/cursor.js";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";
import { ReactionModel, type IReaction, type ReactionKind } from "./reaction.model.js";

type Id = string | Types.ObjectId;

export class ReactionRepository extends ScopedRepository<IReaction> {
  constructor() {
    super(ReactionModel);
  }

  /** True only for the call that actually created the row: counters are bumped exactly once. */
  async add(communityId: Id, memberId: Id, kind: ReactionKind, targetId: Id): Promise<boolean> {
    try {
      await this.createIn(communityId, { memberId: memberId as never, kind, targetId: targetId as never });
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  }

  async remove(communityId: Id, memberId: Id, kind: ReactionKind, targetId: Id): Promise<boolean> {
    return (await this.deleteManyIn(communityId, { memberId, kind, targetId } as never)) > 0;
  }

  async targetsAmong(communityId: Id, memberId: Id, kind: ReactionKind, targetIds: Id[]): Promise<Set<string>> {
    if (targetIds.length === 0) return new Set();
    const rows = await this.findIn(communityId, { memberId, kind, targetId: { $in: targetIds } } as never)
      .select("targetId")
      .lean()
      .exec();
    return new Set(rows.map((r) => r.targetId.toString()));
  }

  async allTargets(communityId: Id, memberId: Id, kind: ReactionKind): Promise<Types.ObjectId[]> {
    const rows = await this.findIn(communityId, { memberId, kind } as never)
      .select("targetId")
      .lean()
      .exec();
    return rows.map((r) => r.targetId);
  }

  async pageOf(communityId: Id, memberId: Id, kind: ReactionKind, cursor: string | undefined, limit: number) {
    const rows = await this.findIn(communityId, { memberId, kind, ...cursorCondition(cursor, "desc") } as never)
      .sort(cursorSort("desc"))
      .limit(limit + 1)
      .exec();
    return toCursorPage(rows, limit);
  }

  removeForTargets(communityId: Id, kinds: ReactionKind[], targetIds: Id[]) {
    return this.deleteManyIn(communityId, { kind: { $in: kinds }, targetId: { $in: targetIds } } as never);
  }
}
