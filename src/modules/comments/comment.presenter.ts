import type { HydratedDocument } from "mongoose";
import type { LinkRewriter } from "../../core/ports/link-rewriter.js";
import { toAuthor } from "../members/member.dto.js";
import type { IMember } from "../members/member.model.js";
import type { MemberService } from "../members/member.service.js";
import type { ReactionService } from "../reactions/reaction.service.js";
import type { IComment } from "./comment.model.js";

type MemberDoc = HydratedDocument<IMember>;
type CommentDoc = HydratedDocument<IComment>;

export class CommentPresenter {
  constructor(
    private readonly members: MemberService,
    private readonly reactions: ReactionService,
    private readonly links: LinkRewriter,
  ) {}

  async present(comments: CommentDoc[], viewer?: MemberDoc) {
    if (comments.length === 0) return [];
    const communityId = comments[0].communityId;
    const memberIds = [
      ...new Set(comments.flatMap((c) => [c.authorId.toString(), ...(c.replyToId ? [c.replyToId.toString()] : [])])),
    ];
    const [people, liked, rendered] = await Promise.all([
      this.members.getByIds(communityId, memberIds),
      this.reactions.flags(
        viewer,
        "comment_like",
        comments.map((c) => c._id),
      ),
      this.links.render(
        comments.map((c) => ({ contentType: "comment" as const, contentId: c.id as string, text: c.body })),
      ),
    ]);
    const byId = new Map(people.map((m) => [m.id as string, m]));

    return comments.map((c) => {
      const own = viewer ? c.authorId.equals(viewer._id) : false;
      const staff = viewer ? viewer.role !== "member" : false;
      const content = rendered.get(`comment:${c.id}`)!;
      const replyTo = c.replyToId ? toAuthor(byId.get(c.replyToId.toString())) : null;
      return {
        id: c.id as string,
        postId: c.postId.toString(),
        parentId: c.parentId ? c.parentId.toString() : null,
        author: toAuthor(byId.get(c.authorId.toString())),
        replyTo: replyTo && { id: replyTo.id, username: replyTo.username, displayName: replyTo.displayName },
        body: content.text,
        links: content.links.map(({ code, shortUrl, host, clicks }) => ({
          code,
          shortUrl,
          host,
          ...(own && { clicks }),
        })),
        status: c.status,
        likesCount: c.likesCount,
        repliesCount: c.repliesCount,
        isLiked: liked.has(c.id),
        isOwn: own,
        editedAt: c.editedAt ?? null,
        createdAt: c.createdAt,
        // Moderation details are for the author and the community's moderators.
        ...((own || staff) && {
          heldReason: c.heldReason ?? null,
          removedReason: c.removedReason ?? null,
          hasPendingEdit: Boolean(c.pendingRevision),
        }),
      };
    });
  }

  async presentOne(comment: CommentDoc, viewer?: MemberDoc) {
    return (await this.present([comment], viewer))[0];
  }
}
