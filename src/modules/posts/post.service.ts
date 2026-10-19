import { randomBytes } from "node:crypto";
import { Types, type HydratedDocument } from "mongoose";
import { AppError } from "../../core/errors/AppError.js";
import type { ContentModerator, TextVerdict } from "../../core/ports/content-moderator.js";
import type { LinkRewriter } from "../../core/ports/link-rewriter.js";
import type { MediaAttachments } from "../../core/ports/media-attachments.js";
import type { Notifier } from "../../core/ports/notifier.js";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";
import { limitsOf, type ICommunity } from "../communities/community.model.js";
import type { IdempotencyStore } from "../idempotency/idempotency.js";
import type { IMember } from "../members/member.model.js";
import type { MemberService } from "../members/member.service.js";
import type { ReactionService } from "../reactions/reaction.service.js";
import type { SocialService } from "../social/social.service.js";
import { extractHashtags, slugify } from "./hashtags.js";
import type { IPost, LinkedResource, PostContent } from "./post.model.js";
import type { PostRepository } from "./post.repository.js";
import { postMachine } from "./post.states.js";

type PostDoc = HydratedDocument<IPost>;
type MemberDoc = HydratedDocument<IMember>;
type CommunityDoc = HydratedDocument<ICommunity>;

export interface CreatePostInput {
  body?: string;
  mediaIds?: string[];
  linkedResource?: LinkedResource;
  idempotencyKey?: string;
}

export interface EditPostInput {
  body?: string;
  mediaIds?: string[];
  linkedResource?: LinkedResource | null;
}

export type ModerateAction = "approve" | "remove" | "reject_edit";

export interface FeedQuery {
  cursor?: string;
  limit: number;
  hashtag?: string;
  q?: string;
}

const TRENDING_TTL_MS = 10 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const unique = <T>(items: T[]) => [...new Set(items)];

export class PostService {
  private readonly trendingCache = new Map<string, { at: number; tags: Array<{ tag: string; count: number }> }>();
  /** Called when soft-deleted posts are purged, so comments and the like can go with them. */
  private onPurge: (communityId: Types.ObjectId, postIds: Types.ObjectId[]) => Promise<void> = async () => {};

  constructor(
    private readonly repository: PostRepository,
    private readonly members: MemberService,
    private readonly social: SocialService,
    private readonly reactions: ReactionService,
    private readonly moderator: ContentModerator,
    private readonly media: MediaAttachments,
    private readonly links: LinkRewriter,
    private readonly notifier: Notifier,
    private readonly idempotency: IdempotencyStore,
  ) {}

  setPurgeHook(hook: (communityId: Types.ObjectId, postIds: Types.ObjectId[]) => Promise<void>) {
    this.onPurge = hook;
  }

  // ---------------------------------------------------------------- create

  async create(community: CommunityDoc, member: MemberDoc, input: CreatePostInput): Promise<PostDoc> {
    const limits = limitsOf(community);
    const body = (input.body ?? "").trim();
    const mediaIds = unique(input.mediaIds ?? []);
    this.assertContent(body, mediaIds.length, limits);

    if (input.idempotencyKey) {
      const existingId = await this.idempotency.find(community._id, member._id, "post", input.idempotencyKey);
      const existing = existingId && (await this.repository.findByIdIn(community._id, existingId));
      if (existing) return existing; // a retry after a lost response: hand back the original
    }

    const verdict = await this.checkText(community, member, body, "post");
    const status = verdict.action === "allow" ? "published" : "pending";
    const _id = new Types.ObjectId();
    const tags = extractHashtags(this.links.stripUrls(body));

    // Links are vetted before images are claimed, so a refused URL leaves nothing half-done.
    await this.links.sync({
      communityId: community.id,
      contentType: "post",
      contentId: _id.toString(),
      authorId: member.id,
      texts: [body],
      maxLinks: limits.maxLinksPerPost,
      live: status === "published",
    });
    const attached = await this.media.attach(community.id, member.id, mediaIds);

    let post: PostDoc;
    try {
      post = await this.insert(community, {
        _id,
        authorId: member._id,
        body,
        hashtags: tags.display,
        hashtagsLower: tags.lower,
        media: attached.map((m) => ({ id: new Types.ObjectId(m.id), url: m.url })),
        linkedResource: input.linkedResource,
        status,
        heldReason: status === "pending" ? "moderation" : undefined,
      });
    } catch (err) {
      await this.media.release(mediaIds).catch(() => undefined);
      throw err;
    }

    if (input.idempotencyKey) {
      await this.idempotency.remember(community._id, member._id, "post", input.idempotencyKey, post._id);
    }
    if (status === "published") await this.enterPublished(post);
    else await this.tellAuthor(post, "Your post is being reviewed by a moderator before it appears.");
    return post;
  }

  private async insert(community: CommunityDoc, data: Record<string, unknown> & { body: string }): Promise<PostDoc> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = `${slugify(data.body) || "post"}-${randomBytes(3).toString("hex")}`;
      try {
        return await this.repository.createIn(community._id, { ...data, slug } as never);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    }
    throw AppError.conflict("Could not allocate a post address, please retry");
  }

  // ------------------------------------------------------------------ edit

  async edit(community: CommunityDoc, member: MemberDoc, idOrSlug: string, input: EditPostInput): Promise<PostDoc> {
    const post = await this.ownPost(community, member, idOrSlug);
    if (post.status === "rejected") throw AppError.conflict("A removed post cannot be edited");
    const limits = limitsOf(community);

    const nextBody = input.body !== undefined ? input.body.trim() : post.body;
    const currentIds = post.media.map((m) => m.id.toString());
    const revisionOnly = (post.pendingRevision?.media ?? [])
      .map((m) => m.id.toString())
      .filter((id) => !currentIds.includes(id));
    const nextIds = input.mediaIds !== undefined ? unique(input.mediaIds) : currentIds;
    const nextLinked = input.linkedResource === undefined ? post.linkedResource : (input.linkedResource ?? undefined);
    this.assertContent(nextBody, nextIds.length, limits);

    const unchanged =
      nextBody === post.body &&
      nextIds.join() === currentIds.join() &&
      JSON.stringify(nextLinked ?? null) === JSON.stringify(post.linkedResource ?? null) &&
      !post.pendingRevision;
    if (unchanged) return post;

    const verdict =
      nextBody !== post.body
        ? await this.checkText(community, member, nextBody, "post", post.id)
        : ({ action: "allow" } as TextVerdict);

    const toAttach = nextIds.filter((id) => !currentIds.includes(id) && !revisionOnly.includes(id));
    const attached = await this.media.attach(community.id, member.id, toAttach);
    const urlOf = new Map([...post.media, ...(post.pendingRevision?.media ?? [])].map((m) => [m.id.toString(), m.url]));
    for (const a of attached) urlOf.set(a.id, a.url);

    const tags = extractHashtags(this.links.stripUrls(nextBody));
    const content: PostContent = {
      body: nextBody,
      hashtags: tags.display,
      hashtagsLower: tags.lower,
      media: nextIds.map((id) => ({ id: new Types.ObjectId(id), url: urlOf.get(id) ?? "" })),
      linkedResource: nextLinked,
    };

    const applyNow = verdict.action === "allow";
    const heldForModeration = post.status === "pending" && post.heldReason === "moderation";
    const becomesPublished = applyNow && heldForModeration;
    const resultingPublished = post.status === "published" || becomesPublished;

    // Held edits keep the live version's links active too, so nothing visible breaks while the edit waits.
    const heldRevision = !applyNow && post.status === "published";
    await this.links.sync({
      communityId: community.id,
      contentType: "post",
      contentId: post.id,
      authorId: member.id,
      texts: heldRevision ? [post.body, nextBody] : [nextBody],
      maxLinks: limits.maxLinksPerPost,
      live: heldRevision ? true : resultingPublished,
    });

    const guard = { _id: post._id, authorId: member._id, status: post.status } as never;
    let updated: PostDoc | null;
    if (heldRevision) {
      updated = await this.repository.updateOneIn(community._id, guard, {
        pendingRevision: { ...content, submittedAt: new Date() },
      } as never);
    } else {
      updated = await this.repository.updateOneIn(community._id, guard, {
        $set: {
          ...content,
          editedAt: new Date(),
          ...(becomesPublished && { status: "published" }),
        },
        $unset: { pendingRevision: 1, ...(becomesPublished && { heldReason: 1 }) },
      } as never);
    }
    if (!updated) {
      await this.media.release(attached.map((a) => a.id)).catch(() => undefined);
      throw AppError.conflict("This post changed while you were editing, please retry");
    }

    // Images no longer used are removed only now that the edit is safely stored.
    const keep = new Set(nextIds);
    const stale = [...(heldRevision ? [] : currentIds), ...revisionOnly].filter((id) => !keep.has(id));
    if (stale.length) await this.media.release(stale);
    if (becomesPublished) await this.enterPublished(updated);
    if (heldRevision)
      await this.tellAuthor(updated, "Your edit is being reviewed. The previous version stays visible until then.");
    return updated;
  }

  // ---------------------------------------------------------------- delete

  /** The author deletes their own post: it disappears everywhere at once (FR-POST-14). */
  async delete(community: CommunityDoc, member: MemberDoc, idOrSlug: string): Promise<void> {
    const post = await this.ownPost(community, member, idOrSlug);
    await this.softDelete(post, "author");
  }

  private async softDelete(post: PostDoc, by: "author" | "account") {
    const wasPublished = post.status === "published";
    const moved = await this.repository.transition(post.communityId, post._id, postMachine.allowedFrom("deleted"), {
      status: "deleted",
      deletedAt: new Date(),
      deletedBy: by,
    });
    if (!moved) throw AppError.notFound("Post not found");
    await this.afterLeaving(post, wasPublished);
  }

  /** Account deleted: every live post of these memberships is deleted, to be purged after the retention window. */
  async deleteAllByMembers(memberIds: Types.ObjectId[]): Promise<void> {
    for (const post of await this.repository.findLiveByAuthors(memberIds)) {
      await this.softDelete(post, "account").catch((err) => {
        if (!(err instanceof AppError)) throw err; // already moved by someone else: fine
      });
    }
  }

  // ------------------------------------------------------------ moderation

  async moderate(community: CommunityDoc, actor: MemberDoc, idOrSlug: string, action: ModerateAction, reason?: string) {
    const post = await this.repository.findByIdOrSlug(community._id, idOrSlug);
    if (!post || post.status === "deleted") throw AppError.notFound("Post not found");

    if (action === "approve") {
      if (post.status === "pending") {
        const moved = await this.repository.transition(community._id, post._id, ["pending"], {
          status: "published",
          $unset: { heldReason: 1 },
        });
        if (!moved) throw AppError.conflict("This post was already handled");
        await this.enterPublished(moved);
        return moved;
      }
      if (post.status === "published" && post.pendingRevision) return this.applyRevision(post);
      throw AppError.conflict("Nothing to approve");
    }

    if (action === "reject_edit") {
      if (!(post.status === "published" && post.pendingRevision)) throw AppError.conflict("There is no held edit");
      return this.discardRevision(post);
    }

    // remove
    if (!reason) throw AppError.badRequest("Give a reason category");
    const wasPublished = post.status === "published";
    const moved = await this.repository.transition(community._id, post._id, postMachine.allowedFrom("rejected"), {
      status: "rejected",
      removedReason: reason,
      $unset: { heldReason: 1, pendingRevision: 1 },
    });
    if (!moved) throw AppError.conflict("This post was already handled");
    await this.afterLeaving(post, wasPublished);
    await this.tellAuthor(moved, `Your post was removed by a moderator (${reason}).`);
    return moved;
  }

  private async applyRevision(post: PostDoc) {
    const revision = post.pendingRevision!;
    await this.links.sync({
      communityId: post.communityId.toString(),
      contentType: "post",
      contentId: post.id,
      authorId: post.authorId.toString(),
      texts: [revision.body],
      maxLinks: 20,
      live: true,
    });
    const content = {
      body: revision.body,
      hashtags: revision.hashtags,
      hashtagsLower: revision.hashtagsLower,
      media: revision.media,
      linkedResource: revision.linkedResource,
    };
    const updated = await this.repository.updateOneIn(
      post.communityId,
      { _id: post._id, status: "published", pendingRevision: { $exists: true } } as never,
      { $set: { ...content, editedAt: new Date() }, $unset: { pendingRevision: 1 } } as never,
    );
    if (!updated) throw AppError.conflict("This post was already handled");
    const keep = new Set(revision.media.map((m) => m.id.toString()));
    await this.media.release(post.media.map((m) => m.id.toString()).filter((id) => !keep.has(id)));
    return updated;
  }

  private async discardRevision(post: PostDoc) {
    const updated = await this.repository.updateOneIn(
      post.communityId,
      { _id: post._id, status: "published", pendingRevision: { $exists: true } } as never,
      { $unset: { pendingRevision: 1 } } as never,
    );
    if (!updated) throw AppError.conflict("This post was already handled");
    const live = new Set(post.media.map((m) => m.id.toString()));
    await this.media.release(
      (post.pendingRevision?.media ?? []).map((m) => m.id.toString()).filter((id) => !live.has(id)),
    );
    await this.links.sync({
      communityId: post.communityId.toString(),
      contentType: "post",
      contentId: post.id,
      authorId: post.authorId.toString(),
      texts: [post.body],
      maxLinks: 20,
      live: true,
    });
    await this.tellAuthor(updated, "Your edit was not approved. The previous version is still shown.");
    return updated;
  }

  /** Reports reached the threshold: take the post out of view until a moderator decides (FR-RPT-4). */
  async holdForReports(communityId: Types.ObjectId, postId: Types.ObjectId): Promise<void> {
    const moved = await this.repository.transition(communityId, postId, ["published"], {
      status: "pending",
      heldReason: "reports",
    });
    if (moved) await this.afterLeaving(moved, true, { keepMedia: true });
  }

  /** Reports were dismissed: bring a post held only by reports back into view. */
  async releaseHold(communityId: Types.ObjectId, postId: Types.ObjectId): Promise<void> {
    const moved = await this.repository.updateOneIn(
      communityId,
      { _id: postId, status: "pending", heldReason: "reports" } as never,
      { status: "published", $unset: { heldReason: 1 } } as never,
    );
    if (moved) await this.enterPublished(moved);
  }

  queue(community: CommunityDoc, cursor: string | undefined, limit: number) {
    return this.repository.pendingQueue(community._id, cursor, limit);
  }

  // ----------------------------------------------------------------- reads

  /** One post as the viewer may see it; everything else answers 404 so ids cannot be probed (NFR-SEC-9). */
  async get(community: CommunityDoc, viewer: MemberDoc | undefined, idOrSlug: string): Promise<PostDoc> {
    const post = await this.repository.findByIdOrSlug(community._id, idOrSlug);
    if (!post || post.status === "deleted") throw AppError.notFound("Post not found");
    const isAuthor = viewer ? post.authorId.equals(viewer._id) : false;
    const isStaff = viewer ? viewer.role !== "member" : false;
    if (post.status !== "published" && !isAuthor && !isStaff) throw AppError.notFound("Post not found");
    if (!isAuthor && !isStaff) await this.assertAuthorVisible(post.authorId, viewer, community);
    return post;
  }

  /** For comments: a published post the viewer may see. */
  async findCommentable(community: CommunityDoc, viewer: MemberDoc | undefined, idOrSlug: string) {
    const post = await this.get(community, viewer, idOrSlug);
    if (post.status !== "published") throw AppError.notFound("Post not found");
    return post;
  }

  async feed(community: CommunityDoc, viewer: MemberDoc | undefined, query: FeedQuery) {
    const { authors, posts } = await this.exclusions(community, viewer);
    const visible = viewer
      ? { $or: [{ status: "published" }, { status: "pending", authorId: viewer._id }] }
      : { status: "published" };
    return this.repository.page(
      community._id,
      {
        ...visible,
        authorId: { $nin: authors },
        _id: { $nin: posts },
        ...(query.hashtag && { hashtagsLower: query.hashtag.toLowerCase().replace(/^#/, "") }),
        ...(query.q && { $text: { $search: query.q } }),
      } as never,
      query.cursor,
      query.limit,
    );
  }

  async byAuthor(
    community: CommunityDoc,
    viewer: MemberDoc | undefined,
    username: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const author = await this.members.getByUsername(community._id, username);
    if (viewer && !viewer._id.equals(author._id) && (await this.social.isBlockedEitherWay(viewer, author._id))) {
      throw AppError.notFound("Member not found");
    }
    const own = viewer ? viewer._id.equals(author._id) : false;
    return this.repository.page(
      community._id,
      { authorId: author._id, status: own ? { $in: ["published", "pending"] } : "published" } as never,
      cursor,
      limit,
    );
  }

  /** The caller's saved posts, most recently saved first. Private to them (FR-PRF-10). */
  async bookmarked(community: CommunityDoc, member: MemberDoc, cursor: string | undefined, limit: number) {
    const page = await this.reactions.page(member, "bookmark", cursor, limit);
    const ids = page.items.map((r) => r.targetId);
    const { authors } = await this.exclusions(community, member);
    const rows = await this.repository
      .findIn(community._id, { _id: { $in: ids }, status: "published", authorId: { $nin: authors } } as never)
      .exec();
    const byId = new Map(rows.map((p) => [p.id as string, p]));
    return { ...page, items: ids.map((id) => byId.get(id.toString())).filter((p): p is PostDoc => Boolean(p)) };
  }

  async trending(community: CommunityDoc) {
    const cached = this.trendingCache.get(community.id);
    if (cached && Date.now() - cached.at < TRENDING_TTL_MS) return cached.tags;
    const tags = await this.repository.trending(community._id, 7, 10);
    this.trendingCache.set(community.id, { at: Date.now(), tags });
    return tags;
  }

  // ------------------------------------------------------------- reactions

  async setLike(community: CommunityDoc, member: MemberDoc, idOrSlug: string, on: boolean) {
    const post = await this.get(community, member, idOrSlug);
    if (post.status !== "published") throw AppError.conflict("Only published posts can be liked");
    if (await this.reactions.set(member, "post_like", post._id, on)) {
      const delta = on ? 1 : -1;
      await this.repository.inc(community._id, post._id, { likesCount: delta });
      await this.members.adjustCounters(community._id, post.authorId, { upvotesCount: delta });
      if (on) {
        await this.notifier.notify({
          communityId: community.id,
          recipientId: post.authorId.toString(),
          actorId: member.id,
          type: "upvote",
          targetType: "post",
          targetId: post.id,
          postId: post.id,
        });
      }
    }
    return this.counts(community, post._id);
  }

  async setBookmark(community: CommunityDoc, member: MemberDoc, idOrSlug: string, on: boolean) {
    const post = await this.get(community, member, idOrSlug);
    if (post.status !== "published") throw AppError.conflict("Only published posts can be saved");
    if (await this.reactions.set(member, "bookmark", post._id, on)) {
      await this.repository.inc(community._id, post._id, { bookmarksCount: on ? 1 : -1 });
    }
    return this.counts(community, post._id);
  }

  async setHidden(community: CommunityDoc, member: MemberDoc, idOrSlug: string, on: boolean) {
    const post = await this.get(community, member, idOrSlug);
    await this.reactions.set(member, "hide", post._id, on);
  }

  /** Bumps `commentsCount` for the comments module. */
  adjustComments(communityId: Types.ObjectId, postId: Types.ObjectId, delta: number) {
    return this.repository.inc(communityId, postId, { commentsCount: delta });
  }

  /** Soft-deleted posts older than the retention window are removed for good (D-9). Returns how many. */
  async purgeExpired(batch = 100): Promise<number> {
    const rows = await this.repository.findPurgeable(new Date(Date.now() - RETENTION_MS), batch);
    const byCommunity = new Map<string, PostDoc[]>();
    for (const p of rows)
      byCommunity.set(p.communityId.toString(), [...(byCommunity.get(p.communityId.toString()) ?? []), p]);
    for (const group of byCommunity.values()) {
      const ids = group.map((p) => p._id);
      await this.onPurge(group[0].communityId, ids);
      await this.reactions.forget(group[0].communityId, ["post_like", "bookmark", "hide"], ids);
      await this.repository.deleteManyIn(group[0].communityId, { _id: { $in: ids } } as never);
    }
    return rows.length;
  }

  // --------------------------------------------------------------- helpers

  private counts = async (community: CommunityDoc, postId: Types.ObjectId) => {
    const post = await this.repository.findByIdIn(community._id, postId);
    if (!post) throw AppError.notFound("Post not found");
    return post;
  };

  private async ownPost(community: CommunityDoc, member: MemberDoc, idOrSlug: string) {
    const post = await this.repository.findByIdOrSlug(community._id, idOrSlug);
    // "Not yours" and "does not exist" look the same.
    if (!post || post.status === "deleted" || !post.authorId.equals(member._id))
      throw AppError.notFound("Post not found");
    return post;
  }

  private assertContent(body: string, imageCount: number, limits: ReturnType<typeof limitsOf>) {
    if (!body && imageCount === 0) throw AppError.badRequest("Write something or add an image");
    if (body.length > limits.postMaxChars)
      throw AppError.badRequest(`Posts can be at most ${limits.postMaxChars} characters`);
    if (imageCount > limits.maxImagesPerPost)
      throw AppError.badRequest(`At most ${limits.maxImagesPerPost} images per post`);
  }

  /** Reject refuses with 422; review and "checker down" both mean hold (fail closed, FR-POST-9). */
  private async checkText(community: CommunityDoc, member: MemberDoc, text: string, source: string, sourceId?: string) {
    if (!text) return { action: "allow", degraded: false, categories: [] } as TextVerdict;
    const verdict = await this.moderator.moderateText(text, {
      communityId: community.id,
      memberId: member.id,
      source,
      sourceId,
    });
    if (verdict.action === "reject") {
      throw AppError.unprocessable("This post cannot be published because it may violate our community guidelines");
    }
    return verdict;
  }

  private async exclusions(community: CommunityDoc, viewer: MemberDoc | undefined) {
    const [inactive, blocked, hidden] = await Promise.all([
      this.members.inactiveIds(community._id),
      viewer ? this.social.hiddenFrom(viewer) : Promise.resolve([]),
      viewer ? this.reactions.allTargets(viewer, "hide") : Promise.resolve([]),
    ]);
    return { authors: [...inactive, ...blocked], posts: hidden };
  }

  private async assertAuthorVisible(authorId: Types.ObjectId, viewer: MemberDoc | undefined, community: CommunityDoc) {
    const [author] = await this.members.getByIds(community._id, [authorId]);
    if (!author || author.status !== "active") throw AppError.notFound("Post not found");
    if (viewer && (await this.social.isBlockedEitherWay(viewer, authorId))) throw AppError.notFound("Post not found");
  }

  /** Effects of a post becoming visible: counters up, links live. */
  private async enterPublished(post: PostDoc) {
    await this.members.adjustCounters(post.communityId, post.authorId, {
      postsCount: 1,
      upvotesCount: post.likesCount,
    });
    await this.links.setLive("post", [post.id], true);
  }

  /** Effects of a post stopping being visible, whatever the reason. Idempotent. */
  private async afterLeaving(post: PostDoc, wasPublished: boolean, opts: { keepMedia?: boolean } = {}) {
    const communityId = post.communityId.toString();
    if (wasPublished) {
      await this.members.adjustCounters(post.communityId, post.authorId, {
        postsCount: -1,
        upvotesCount: -post.likesCount,
      });
    }
    await this.links.setLive("post", [post.id], false);
    await this.notifier.removeForTargets(communityId, "post", [post.id]);
    if (opts.keepMedia) return;
    await this.reactions.forget(post.communityId, ["bookmark", "hide"], [post._id]);
    const live = post.media.map((m) => m.id.toString());
    const revisionOnly = (post.pendingRevision?.media ?? [])
      .map((m) => m.id.toString())
      .filter((id) => !live.includes(id));
    await this.media.release([...live, ...revisionOnly]);
  }

  private tellAuthor(post: PostDoc, body: string) {
    return this.notifier.notify({
      communityId: post.communityId.toString(),
      recipientId: post.authorId.toString(),
      type: "moderation",
      targetType: "post",
      targetId: post.id,
      postId: post.id,
      title: "Update on your post",
      body,
    });
  }
}
