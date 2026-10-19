import type { HydratedDocument, Types } from "mongoose";
import type { IMember } from "../members/member.model.js";
import type { ReactionKind } from "./reaction.model.js";
import type { ReactionRepository } from "./reaction.repository.js";

type MemberDoc = HydratedDocument<IMember>;
type Id = string | Types.ObjectId;

/** Likes, bookmarks and hidden posts. Owners of the target keep their own counters, using the boolean this returns. */
export class ReactionService {
  constructor(private readonly repository: ReactionRepository) {}

  /** Turns a reaction on or off. Returns true only when this call changed something (so counters move once). */
  set(member: MemberDoc, kind: ReactionKind, targetId: Id, on: boolean): Promise<boolean> {
    return on
      ? this.repository.add(member.communityId, member._id, kind, targetId)
      : this.repository.remove(member.communityId, member._id, kind, targetId);
  }

  flags(member: MemberDoc | undefined, kind: ReactionKind, ids: Id[]): Promise<Set<string>> {
    if (!member) return Promise.resolve(new Set());
    return this.repository.targetsAmong(member.communityId, member._id, kind, ids);
  }

  allTargets(member: MemberDoc, kind: ReactionKind) {
    return this.repository.allTargets(member.communityId, member._id, kind);
  }

  page(member: MemberDoc, kind: ReactionKind, cursor: string | undefined, limit: number) {
    return this.repository.pageOf(member.communityId, member._id, kind, cursor, limit);
  }

  /** Content removed for everyone: drop the bookmarks and hides that point at it. Likes go with the content. */
  forget(communityId: Id, kinds: ReactionKind[], targetIds: Id[]) {
    if (targetIds.length === 0) return Promise.resolve(0);
    return this.repository.removeForTargets(communityId, kinds, targetIds);
  }
}
