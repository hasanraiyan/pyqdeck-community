import { randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import { ScopedRepository } from "../../core/base/ScopedRepository.js";
import { MemberModel, type IMember } from "./member.model.js";
import type { MemberStatus } from "./member.states.js";

type Id = string | Types.ObjectId;

export class MemberRepository extends ScopedRepository<IMember> {
  constructor() {
    super(MemberModel);
  }

  findByAccount(communityId: Id, accountId: Id) {
    return this.findOneIn(communityId, { accountId });
  }

  findByUsername(communityId: Id, username: string) {
    return this.findOneIn(communityId, { username: username.toLowerCase() });
  }

  async isUsernameTaken(communityId: Id, username: string) {
    return (await this.existsIn(communityId, { username })) !== null;
  }

  /** Members whose content must not appear in anyone's feed (suspended or deleted). Small in practice. */
  async inactiveIds(communityId: Id): Promise<Types.ObjectId[]> {
    const rows = await this.findIn(communityId, { status: { $ne: "active" } })
      .select("_id")
      .lean()
      .exec();
    return rows.map((r) => r._id);
  }

  findManyIn(communityId: Id, ids: Array<Id>) {
    return this.findIn(communityId, { _id: { $in: ids } }).exec();
  }

  /** Guarded status change (see `memberMachine`): matches only while the member is in one of the `from` states. */
  transition(communityId: Id, memberId: Id, from: MemberStatus[], patch: Partial<IMember>) {
    return this.updateOneIn(communityId, { _id: memberId, status: { $in: from } }, patch);
  }

  inc(
    communityId: Id,
    memberId: Id,
    counters: Partial<Record<"followersCount" | "followingCount" | "postsCount" | "upvotesCount", number>>,
  ) {
    return this.model.updateOne({ _id: memberId, communityId }, { $inc: counters }).exec();
  }

  searchIn(communityId: Id, pattern: RegExp, limit: number) {
    return this.findIn(communityId, {
      status: "active",
      $or: [{ username: pattern }, { displayName: pattern }],
    })
      .sort({ followersCount: -1, _id: 1 })
      .limit(limit)
      .exec();
  }

  /** Every membership of one account, across communities. Used only by the account-deletion path. */
  findAllOfAccount(accountId: Id) {
    return this.model.find({ accountId }).exec();
  }

  /** Scrubs a membership in place: the row stays so posts keep a valid author, the handle is freed. */
  scrub(memberId: Id) {
    return this.model
      .findOneAndUpdate(
        { _id: memberId, status: { $ne: "deleted" } },
        {
          status: "deleted",
          username: `deleted_${randomBytes(5).toString("hex")}`,
          displayName: "Deleted user",
          avatarUrl: "",
          coverUrl: "",
          avatarMediaId: null,
          coverMediaId: null,
          headline: "",
          bio: "",
          location: "",
          github: "",
          linkedin: "",
          twitter: "",
          website: "",
          skills: [],
          attributes: {},
          role: "member",
        },
        { returnDocument: "after" },
      )
      .exec();
  }
}
