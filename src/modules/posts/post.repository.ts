import type { QueryFilter, Types } from "mongoose";
import { ScopedRepository } from "../../core/base/ScopedRepository.js";
import { cursorCondition, cursorSort, toCursorPage } from "../../core/utils/cursor.js";
import { PostModel, type IPost } from "./post.model.js";
import type { PostStatus } from "./post.states.js";

type Id = string | Types.ObjectId;
type Counters = Partial<Record<"likesCount" | "commentsCount" | "bookmarksCount", number>>;

export class PostRepository extends ScopedRepository<IPost> {
  constructor() {
    super(PostModel);
  }

  /** Resolves a post by id or by slug, inside the community only. */
  findByIdOrSlug(communityId: Id, idOrSlug: string) {
    const isId = /^[0-9a-f]{24}$/i.test(idOrSlug);
    return this.findOneIn(communityId, (isId ? { _id: idOrSlug } : { slug: idOrSlug }) as QueryFilter<IPost>);
  }

  async page(communityId: Id, filter: QueryFilter<IPost>, cursor: string | undefined, limit: number) {
    const after = cursorCondition(cursor, "desc");
    const rows = await this.findIn(communityId, (cursor ? { $and: [filter, after] } : filter) as QueryFilter<IPost>)
      .sort(cursorSort("desc"))
      .limit(limit + 1)
      .exec();
    return toCursorPage(rows, limit);
  }

  /**
   * Guarded status change (`postMachine`): applies only while the post is still in one of the `from` states, so two
   * moderators or an author and a moderator acting at once cannot both win. Returns null when it did not apply.
   */
  transition(communityId: Id, postId: Id, from: PostStatus[], patch: Record<string, unknown>) {
    return this.updateOneIn(communityId, { _id: postId, status: { $in: from } } as never, patch as never);
  }

  inc(communityId: Id, postId: Id, counters: Counters) {
    return this.model.updateOne({ _id: postId, communityId }, { $inc: counters }).exec();
  }

  pendingQueue(communityId: Id, cursor: string | undefined, limit: number) {
    return this.page(
      communityId,
      { $or: [{ status: "pending" }, { status: "published", pendingRevision: { $exists: true } }] } as never,
      cursor,
      limit,
    );
  }

  /** Top hashtags over the last `days` days by number of distinct published posts. */
  async trending(communityId: Id, days: number, top: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.model
      .aggregate<{ _id: string; tag: string; count: number }>([
        { $match: { communityId: communityId as never, status: "published", createdAt: { $gte: since } } },
        { $unwind: "$hashtags" },
        { $group: { _id: { $toLower: "$hashtags" }, tag: { $first: "$hashtags" }, posts: { $addToSet: "$_id" } } },
        { $project: { tag: 1, count: { $size: "$posts" } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: top },
      ])
      .exec();
    return rows.map((r) => ({ tag: r.tag, count: r.count }));
  }

  findLiveByAuthors(authorIds: Id[]) {
    return this.model.find({ authorId: { $in: authorIds }, status: { $ne: "deleted" } }).exec();
  }

  findPurgeable(cutoff: Date, limit: number) {
    return this.model
      .find({ status: "deleted", deletedAt: { $lt: cutoff } })
      .limit(limit)
      .exec();
  }
}
