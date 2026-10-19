import { Types, type HydratedDocument } from "mongoose";
import { AppError } from "../../core/errors/AppError.js";
import { refusalMessage, type ContentModerator } from "../../core/ports/content-moderator.js";
import type { LinkRewriter } from "../../core/ports/link-rewriter.js";
import type { Notifier } from "../../core/ports/notifier.js";
import { limitsOf, type ICommunity } from "../communities/community.model.js";
import type { IdempotencyStore } from "../idempotency/idempotency.js";
import type { IMember } from "../members/member.model.js";
import type { MemberService } from "../members/member.service.js";
import type { ReactionService } from "../reactions/reaction.service.js";
import type { SocialService } from "../social/social.service.js";
import type { IComment } from "./comment.model.js";
import type { CommentRepository } from "./comment.repository.js";

type CommentDoc = HydratedDocument<IComment>;
type MemberDoc = HydratedDocument<IMember>;
type CommunityDoc = HydratedDocument<ICommunity>;

/** What comments need from posts. The posts module satisfies it structurally; comments never import it. */
export interface PostAccess {
  /** A published post the viewer may see, else a 404/409 `AppError`. */
  findCommentable(
    community: CommunityDoc,
    viewer: MemberDoc | undefined,
    idOrSlug: string,
  ): Promise<{ _id: Types.ObjectId; id: string; authorId: Types.ObjectId }>;
  adjustComments(communityId: Types.ObjectId, postId: Types.ObjectId, delta: number): Promise<unknown>;
}

export interface CreateCommentInput {
  body: string;
  parentId?: string;
  idempotencyKey?: string;
}

export class CommentService {
  constructor(
    private readonly repository: CommentRepository,
    private readonly posts: PostAccess,
    private readonly members: MemberService,
    private readonly social: SocialService,
    private readonly reactions: ReactionService,
    private readonly moderator: ContentModerator,
    private readonly links: LinkRewriter,
    private readonly notifier: Notifier,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async create(community: CommunityDoc, member: MemberDoc, postIdOrSlug: string, input: CreateCommentInput) {
    const limits = limitsOf(community);
    const body = input.body.trim();
    if (!body) throw AppError.badRequest("Write a comment first");
    if (body.length > limits.commentMaxChars) {
      throw AppError.badRequest(`Comments can be at most ${limits.commentMaxChars} characters`);
    }

    if (input.idempotencyKey) {
      const id = await this.idempotency.find(community._id, member._id, "comment", input.idempotencyKey);
      const existing = id && (await this.repository.findByIdIn(community._id, id));
      if (existing) return existing;
    }

    const post = await this.posts.findCommentable(community, member, postIdOrSlug);

    // A reply to a reply is stored under the thread's top-level comment and remembers who it answers (FR-CMT-3).
    let rootId: Types.ObjectId | null = null;
    let replyTo: Types.ObjectId | undefined;
    if (input.parentId) {
      if (!Types.ObjectId.isValid(input.parentId)) throw AppError.badRequest("Invalid parent comment");
      const parent = await this.repository.findByIdIn(community._id, input.parentId);
      if (!parent || !parent.postId.equals(post._id) || parent.status !== "published") {
        throw AppError.notFound("Comment not found");
      }
      if (await this.social.isBlockedEitherWay(member, parent.authorId)) throw AppError.notFound("Comment not found");
      rootId = parent.parentId ?? parent._id;
      replyTo = parent.authorId;
    }

    const verdict = await this.moderator.moderateText(body, {
      communityId: community.id,
      memberId: member.id,
      source: "comment",
    });
    if (verdict.action === "reject") {
      throw AppError.unprocessable(
        refusalMessage(
          verdict.categories,
          "This comment cannot be posted because it may violate our community guidelines",
        ),
      );
    }
    const status = verdict.action === "allow" ? "published" : "pending";

    const _id = new Types.ObjectId();
    await this.links.sync({
      communityId: community.id,
      contentType: "comment",
      contentId: _id.toString(),
      authorId: member.id,
      texts: [body],
      maxLinks: limits.maxLinksPerComment,
      live: status === "published",
    });

    const comment = await this.repository.createIn(community._id, {
      _id,
      postId: post._id,
      authorId: member._id,
      parentId: rootId,
      replyToId: replyTo,
      body,
      status,
      heldReason: status === "pending" ? "moderation" : undefined,
    } as never);

    if (input.idempotencyKey) {
      await this.idempotency.remember(community._id, member._id, "comment", input.idempotencyKey, comment._id);
    }
    if (status === "published") {
      await this.enterPublished(comment);
      await this.notifyAboutNew(community, member, post, comment, replyTo);
    } else {
      await this.notifier.notify({
        communityId: community.id,
        recipientId: member.id,
        type: "moderation",
        targetType: "comment",
        targetId: comment.id,
        postId: post.id,
        title: "Update on your comment",
        body: "Your comment is being reviewed by a moderator before it appears.",
      });
    }
    return comment;
  }

  /** Top-level comments of a post, oldest first. The viewer also sees their own held comments. */
  async list(
    community: CommunityDoc,
    viewer: MemberDoc | undefined,
    postIdOrSlug: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const post = await this.posts.findCommentable(community, viewer, postIdOrSlug);
    return this.threadPage(community, viewer, { postId: post._id, parentId: null }, cursor, limit);
  }

  async replies(
    community: CommunityDoc,
    viewer: MemberDoc | undefined,
    commentId: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const root = await this.findVisible(community, viewer, commentId);
    if (root.parentId) throw AppError.notFound("Comment not found");
    return this.threadPage(community, viewer, { postId: root.postId, parentId: root._id }, cursor, limit);
  }

  private async threadPage(
    community: CommunityDoc,
    viewer: MemberDoc | undefined,
    where: { postId: Types.ObjectId; parentId: Types.ObjectId | null },
    cursor: string | undefined,
    limit: number,
  ) {
    const [inactive, blocked] = await Promise.all([
      this.members.inactiveIds(community._id),
      viewer ? this.social.hiddenFrom(viewer) : Promise.resolve([]),
    ]);
    const visible = viewer
      ? { $or: [{ status: "published" }, { status: "pending", authorId: viewer._id }] }
      : { status: "published" };
    return this.repository.page(
      community._id,
      { ...where, ...visible, authorId: { $nin: [...inactive, ...blocked] } } as never,
      cursor,
      limit,
    );
  }

  async edit(community: CommunityDoc, member: MemberDoc, commentId: string, rawBody: string) {
    const comment = await this.own(community, member, commentId);
    if (comment.status === "rejected") throw AppError.conflict("A removed comment cannot be edited");
    const limits = limitsOf(community);
    const body = rawBody.trim();
    if (!body) throw AppError.badRequest("Write a comment first");
    if (body.length > limits.commentMaxChars) {
      throw AppError.badRequest(`Comments can be at most ${limits.commentMaxChars} characters`);
    }
    if (body === comment.body && !comment.pendingRevision) return comment;

    const verdict = await this.moderator.moderateText(body, {
      communityId: community.id,
      memberId: member.id,
      source: "comment",
      sourceId: comment.id,
    });
    if (verdict.action === "reject") {
      throw AppError.unprocessable(
        refusalMessage(verdict.categories, "This comment may violate our community guidelines"),
      );
    }

    const heldRevision = verdict.action !== "allow" && comment.status === "published";
    await this.links.sync({
      communityId: community.id,
      contentType: "comment",
      contentId: comment.id,
      authorId: member.id,
      texts: heldRevision ? [comment.body, body] : [body],
      maxLinks: limits.maxLinksPerComment,
      live: comment.status === "published",
    });

    const guard = { _id: comment._id, authorId: member._id, status: comment.status } as never;
    const updated = heldRevision
      ? await this.repository.updateOneIn(community._id, guard, {
          pendingRevision: { body, submittedAt: new Date() },
        } as never)
      : await this.repository.updateOneIn(community._id, guard, {
          $set: { body, editedAt: new Date() },
          $unset: { pendingRevision: 1 },
        } as never);
    if (!updated) throw AppError.conflict("This comment changed, please retry");
    return updated;
  }

  /** The author, the post's author and moderators may delete a comment (FR-CMT-6, FR-CMT-8). */
  async delete(community: CommunityDoc, actor: MemberDoc, commentId: string) {
    const comment = await this.findLive(community, commentId);
    const isAuthor = comment.authorId.equals(actor._id);
    const isStaff = actor.role !== "member";
    let by: NonNullable<IComment["deletedBy"]> = isAuthor ? "author" : "moderator";
    if (!isAuthor && !isStaff) {
      const post = await this.posts.findCommentable(community, actor, comment.postId.toString()).catch(() => null);
      if (!post || !post.authorId.equals(actor._id)) throw AppError.notFound("Comment not found");
      by = "post_author";
    }
    await this.softDelete(comment, by);
  }

  private async softDelete(comment: CommentDoc, by: NonNullable<IComment["deletedBy"]>) {
    const wasPublished = comment.status === "published";
    const moved = await this.repository.transition(comment.communityId, comment._id, "deleted", {
      deletedAt: new Date(),
      deletedBy: by,
    });
    if (!moved) throw AppError.notFound("Comment not found");

    let removedFromCount = wasPublished ? 1 : 0;
    const ids = [comment.id as string];
    if (!comment.parentId) removedFromCount += await this.repository.deleteReplies(comment.communityId, comment._id);
    else if (wasPublished) await this.repository.inc(comment.communityId, comment.parentId, { repliesCount: -1 });

    if (removedFromCount > 0) await this.posts.adjustComments(comment.communityId, comment.postId, -removedFromCount);
    await this.links.setLive("comment", ids, false);
    await this.notifier.removeForTargets(comment.communityId.toString(), "comment", ids);
  }

  // ------------------------------------------------------------ moderation

  async moderate(
    community: CommunityDoc,
    commentId: string,
    action: "approve" | "remove" | "reject_edit",
    reason?: string,
  ) {
    const comment = await this.findLive(community, commentId);
    if (action === "approve") {
      if (comment.status === "pending") {
        const moved = await this.repository.transition(community._id, comment._id, "published", {
          $unset: { heldReason: 1 },
        });
        if (!moved) throw AppError.conflict("This comment was already handled");
        await this.enterPublished(moved);
        return moved;
      }
      if (comment.status === "published" && comment.pendingRevision) {
        const updated = await this.repository.updateOneIn(
          community._id,
          { _id: comment._id, status: "published", pendingRevision: { $exists: true } } as never,
          {
            $set: { body: comment.pendingRevision.body, editedAt: new Date() },
            $unset: { pendingRevision: 1 },
          } as never,
        );
        if (!updated) throw AppError.conflict("This comment was already handled");
        return updated;
      }
      throw AppError.conflict("Nothing to approve");
    }
    if (action === "reject_edit") {
      const updated = await this.repository.updateOneIn(
        community._id,
        { _id: comment._id, pendingRevision: { $exists: true } } as never,
        { $unset: { pendingRevision: 1 } } as never,
      );
      if (!updated) throw AppError.conflict("There is no held edit");
      return updated;
    }
    if (!reason) throw AppError.badRequest("Give a reason category");
    const wasPublished = comment.status === "published";
    const moved = await this.repository.transition(community._id, comment._id, "rejected", {
      removedReason: reason,
      $unset: { heldReason: 1, pendingRevision: 1 },
    });
    if (!moved) throw AppError.conflict("This comment was already handled");
    if (wasPublished) await this.leavePublished(comment);
    await this.links.setLive("comment", [comment.id], false);
    await this.notifier.removeForTargets(community.id, "comment", [comment.id]);
    await this.notifier.notify({
      communityId: community.id,
      recipientId: comment.authorId.toString(),
      type: "moderation",
      targetType: "comment",
      targetId: comment.id,
      postId: comment.postId.toString(),
      title: "Update on your comment",
      body: `Your comment was removed by a moderator (${reason}).`,
    });
    return moved;
  }

  async releaseHold(communityId: Types.ObjectId, commentId: Types.ObjectId) {
    const moved = await this.repository.updateOneIn(
      communityId,
      { _id: commentId, status: "pending", heldReason: "reports" } as never,
      { status: "published", $unset: { heldReason: 1 } } as never,
    );
    if (moved) await this.enterPublished(moved);
  }

  /** A comment the viewer may see, for reports and deep links. */
  getVisible(community: CommunityDoc, viewer: MemberDoc | undefined, id: string) {
    return this.findVisible(community, viewer, id);
  }

  queue(community: CommunityDoc, cursor: string | undefined, limit: number) {
    return this.repository.queue(community._id, cursor, limit);
  }

  async holdForReports(communityId: Types.ObjectId, commentId: Types.ObjectId) {
    const moved = await this.repository.transition(communityId, commentId, "pending", { heldReason: "reports" });
    if (moved) await this.leavePublished(moved);
  }

  // ------------------------------------------------------------- reactions

  async setLike(community: CommunityDoc, member: MemberDoc, commentId: string, on: boolean) {
    const comment = await this.findVisible(community, member, commentId);
    if (comment.status !== "published") throw AppError.conflict("Only published comments can be liked");
    if (await this.reactions.set(member, "comment_like", comment._id, on)) {
      await this.repository.inc(community._id, comment._id, { likesCount: on ? 1 : -1 });
    }
    return (await this.repository.findByIdIn(community._id, comment._id))!;
  }

  likedAmong(viewer: MemberDoc | undefined, ids: Types.ObjectId[]) {
    return this.reactions.flags(viewer, "comment_like", ids);
  }

  // ---------------------------------------------------------------- others

  async deleteAllByMembers(memberIds: Types.ObjectId[]) {
    for (const c of await this.repository.findLiveByAuthors(memberIds)) {
      await this.softDelete(c, "account").catch((err) => {
        if (!(err instanceof AppError)) throw err;
      });
    }
  }

  async purgeForPosts(communityId: Types.ObjectId, postIds: Types.ObjectId[]) {
    await this.repository.deleteForPosts(communityId, postIds);
  }

  // --------------------------------------------------------------- helpers

  private async findLive(community: CommunityDoc, id: string) {
    if (!Types.ObjectId.isValid(id)) throw AppError.notFound("Comment not found");
    const comment = await this.repository.findByIdIn(community._id, id);
    if (!comment || comment.status === "deleted") throw AppError.notFound("Comment not found");
    return comment;
  }

  private async own(community: CommunityDoc, member: MemberDoc, id: string) {
    const comment = await this.findLive(community, id);
    if (!comment.authorId.equals(member._id)) throw AppError.notFound("Comment not found");
    return comment;
  }

  /** A comment the viewer may see: published (or their own), on a post they may see, by someone not blocked. */
  private async findVisible(community: CommunityDoc, viewer: MemberDoc | undefined, id: string) {
    const comment = await this.findLive(community, id);
    const isAuthor = viewer ? comment.authorId.equals(viewer._id) : false;
    if (comment.status !== "published" && !isAuthor && !(viewer && viewer.role !== "member")) {
      throw AppError.notFound("Comment not found");
    }
    await this.posts.findCommentable(community, viewer, comment.postId.toString());
    if (viewer && !isAuthor && (await this.social.isBlockedEitherWay(viewer, comment.authorId))) {
      throw AppError.notFound("Comment not found");
    }
    return comment;
  }

  private async enterPublished(comment: CommentDoc) {
    await this.posts.adjustComments(comment.communityId, comment.postId, 1);
    if (comment.parentId) await this.repository.inc(comment.communityId, comment.parentId, { repliesCount: 1 });
    await this.links.setLive("comment", [comment.id], true);
  }

  private async leavePublished(comment: CommentDoc) {
    // Replies of a held top-level comment stay stored and counted; they are handled when the root is deleted.
    if (comment.parentId) await this.repository.inc(comment.communityId, comment.parentId, { repliesCount: -1 });
    await this.posts.adjustComments(comment.communityId, comment.postId, -1);
  }

  private async notifyAboutNew(
    community: CommunityDoc,
    member: MemberDoc,
    post: { id: string; authorId: Types.ObjectId },
    comment: CommentDoc,
    replyTo: Types.ObjectId | undefined,
  ) {
    const base = {
      communityId: community.id,
      actorId: member.id,
      targetType: "comment" as const,
      targetId: comment.id,
      postId: post.id,
    };
    if (replyTo) await this.notifier.notify({ ...base, recipientId: replyTo.toString(), type: "reply" });
    if (!replyTo || !replyTo.equals(post.authorId)) {
      await this.notifier.notify({ ...base, recipientId: post.authorId.toString(), type: "comment" });
    }
  }
}
