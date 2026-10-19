import type { QueryFilter, Types } from "mongoose";
import { ScopedRepository } from "../../core/base/ScopedRepository.js";
import { cursorCondition, cursorSort, toCursorPage } from "../../core/utils/cursor.js";
import { commentMachine, CommentModel, type CommentStatus, type IComment } from "./comment.model.js";

type Id = string | Types.ObjectId;

export class CommentRepository extends ScopedRepository<IComment> {
  constructor() {
    super(CommentModel);
  }

  /** Oldest first (FR-CMT-2), with a cursor so new comments never shift a page. */
  async page(communityId: Id, filter: QueryFilter<IComment>, cursor: string | undefined, limit: number) {
    const after = cursorCondition(cursor, "asc");
    const rows = await this.findIn(communityId, (cursor ? { $and: [filter, after] } : filter) as QueryFilter<IComment>)
      .sort(cursorSort("asc"))
      .limit(limit + 1)
      .exec();
    return toCursorPage(rows, limit);
  }

  /** Guarded status change: applies only while the comment is in one of the `from` states. */
  transition(communityId: Id, id: Id, to: CommentStatus, patch: Record<string, unknown> = {}) {
    return this.updateOneIn(
      communityId,
      { _id: id, status: { $in: commentMachine.allowedFrom(to) } } as never,
      { status: to, ...patch } as never,
    );
  }

  inc(communityId: Id, id: Id, counters: Partial<Record<"likesCount" | "repliesCount", number>>) {
    return this.model.updateOne({ _id: id, communityId }, { $inc: counters }).exec();
  }

  countPublishedReplies(communityId: Id, rootId: Id) {
    return this.countIn(communityId, { parentId: rootId, status: "published" } as never);
  }

  /** Replies of a deleted top-level comment go with it. Returns how many were published (for the post counter). */
  async deleteReplies(communityId: Id, rootId: Id): Promise<number> {
    const published = await this.countPublishedReplies(communityId, rootId);
    await this.updateManyIn(
      communityId,
      { parentId: rootId, status: { $ne: "deleted" } } as never,
      { status: "deleted", deletedAt: new Date(), deletedBy: "parent" } as never,
    );
    return published;
  }

  queue(communityId: Id, cursor: string | undefined, limit: number) {
    return this.page(
      communityId,
      { $or: [{ status: "pending" }, { status: "published", pendingRevision: { $exists: true } }] } as never,
      cursor,
      limit,
    );
  }

  findLiveByAuthors(authorIds: Id[]) {
    return this.model.find({ authorId: { $in: authorIds }, status: { $ne: "deleted" } }).exec();
  }

  deleteForPosts(communityId: Id, postIds: Id[]) {
    return this.deleteManyIn(communityId, { postId: { $in: postIds } } as never);
  }
}
