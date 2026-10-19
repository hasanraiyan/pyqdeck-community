import type { HydratedDocument } from "mongoose";
import type { LinkRewriter } from "../../core/ports/link-rewriter.js";
import { toAuthor } from "../members/member.dto.js";
import type { IMember } from "../members/member.model.js";
import type { MemberService } from "../members/member.service.js";
import type { ReactionService } from "../reactions/reaction.service.js";
import type { IPost } from "./post.model.js";

type MemberDoc = HydratedDocument<IMember>;
type PostDoc = HydratedDocument<IPost>;

/** Turns stored posts into what clients receive: author, viewer flags, short links substituted into the text. */
export class PostPresenter {
  constructor(
    private readonly members: MemberService,
    private readonly reactions: ReactionService,
    private readonly links: LinkRewriter,
  ) {}

  async present(posts: PostDoc[], viewer?: MemberDoc) {
    if (posts.length === 0) return [];
    const communityId = posts[0].communityId;
    const ids = posts.map((p) => p._id);

    const [authors, liked, bookmarked, rendered] = await Promise.all([
      this.members.getByIds(communityId, [...new Set(posts.map((p) => p.authorId.toString()))]),
      this.reactions.flags(viewer, "post_like", ids),
      this.reactions.flags(viewer, "bookmark", ids),
      this.links.render(posts.map((p) => ({ contentType: "post" as const, contentId: p.id as string, text: p.body }))),
    ]);
    const authorById = new Map(authors.map((a) => [a.id as string, a]));

    return posts.map((post) => {
      const own = viewer ? post.authorId.equals(viewer._id) : false;
      const content = rendered.get(`post:${post.id}`)!;
      return {
        id: post.id as string,
        slug: post.slug,
        author: toAuthor(authorById.get(post.authorId.toString())),
        body: content.text,
        hashtags: post.hashtags,
        media: post.media.map((m) => ({ id: m.id.toString(), url: m.url })),
        linkedResource: post.linkedResource ?? null,
        links: content.links.map(({ code, shortUrl, host, clicks }) => ({
          code,
          shortUrl,
          host,
          ...(own && { clicks }),
        })),
        status: post.status,
        likesCount: post.likesCount,
        commentsCount: post.commentsCount,
        bookmarksCount: post.bookmarksCount,
        isLiked: liked.has(post.id),
        isBookmarked: bookmarked.has(post.id),
        isOwnPost: own,
        editedAt: post.editedAt ?? null,
        createdAt: post.createdAt,
        // Moderation details are for the author only (FR-POST-19); nobody else learns a post was ever held.
        // The author edits the text as typed; readers only ever get the short-link version (FR-LNK-3).
        ...(own && {
          rawBody: post.body,
          heldReason: post.heldReason ?? null,
          removedReason: post.removedReason ?? null,
          hasPendingEdit: Boolean(post.pendingRevision),
        }),
      };
    });
  }

  async presentOne(post: PostDoc, viewer?: MemberDoc) {
    return (await this.present([post], viewer))[0];
  }
}

export type PostDto = Awaited<ReturnType<PostPresenter["presentOne"]>>;
