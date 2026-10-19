import { Router } from "express";
import { Types } from "mongoose";
import { AppError } from "./core/errors/AppError.js";
import { getAccountService } from "./modules/accounts/account.module.js";
import { CommentPresenter } from "./modules/comments/comment.presenter.js";
import { CommentRepository } from "./modules/comments/comment.repository.js";
import { createCommentRoutes } from "./modules/comments/comment.routes.js";
import { CommentService } from "./modules/comments/comment.service.js";
import { createResolveCommunity } from "./modules/communities/community.middleware.js";
import { createCommunityInfoRoutes } from "./modules/communities/community.routes.js";
import { attachMember } from "./modules/auth/auth.middleware.js";
import { IdempotencyStore } from "./modules/idempotency/idempotency.js";
import { createLinkApiRoutes } from "./modules/links/link.routes.js";
import { getLinkService } from "./modules/links/links.module.js";
import { createMediaRoutes } from "./modules/media/media.routes.js";
import { getMediaService } from "./modules/media/media.module.js";
import { getMemberService } from "./modules/members/member.module.js";
import { createMemberRoutes } from "./modules/members/member.routes.js";
import { createModerationRoutes } from "./modules/moderation/moderation.routes.js";
import { getContentModerator } from "./modules/moderation/moderation.module.js";
import { NotificationRepository } from "./modules/notifications/notification.repository.js";
import { createNotificationRoutes } from "./modules/notifications/notification.routes.js";
import { NotificationService } from "./modules/notifications/notification.service.js";
import { PostPresenter } from "./modules/posts/post.presenter.js";
import { PostRepository } from "./modules/posts/post.repository.js";
import { createPostCompanionRoutes, createPostRoutes } from "./modules/posts/post.routes.js";
import { PostService } from "./modules/posts/post.service.js";
import { ReactionRepository } from "./modules/reactions/reaction.repository.js";
import { ReactionService } from "./modules/reactions/reaction.service.js";
import { createReportRoutes } from "./modules/reports/report.routes.js";
import {
  ReportRepository,
  ReportService,
  type ReportActions,
  type ReportTargetResolver,
} from "./modules/reports/report.service.js";
import type { ReportTarget } from "./modules/reports/report.model.js";
import { BlockRepository, FollowRepository } from "./modules/social/social.repository.js";
import { SocialService } from "./modules/social/social.service.js";

/**
 * The composition root for the community features: the one place that knows how modules plug into each other.
 * Modules depend on small ports (see `core/ports`); this file hands them the concrete services.
 */
function build() {
  const members = getMemberService();
  const notifications = new NotificationService(new NotificationRepository(), members);
  const social = new SocialService(new FollowRepository(), new BlockRepository(), members, notifications);
  const reactions = new ReactionService(new ReactionRepository());
  const idempotency = new IdempotencyStore();
  const moderator = getContentModerator();
  const media = getMediaService();
  const links = getLinkService();

  const posts = new PostService(
    new PostRepository(),
    members,
    social,
    reactions,
    moderator,
    media,
    links,
    notifications,
    idempotency,
  );
  const comments = new CommentService(
    new CommentRepository(),
    posts,
    members,
    social,
    reactions,
    moderator,
    links,
    notifications,
    idempotency,
  );

  posts.setPurgeHook((communityId, postIds) => comments.purgeForPosts(communityId, postIds));

  // When a Clerk account is deleted, its memberships are scrubbed and everything it posted goes into the 30-day window.
  getAccountService().onDeleted(async (account) => {
    const memberships = await members.scrubAccount(account._id);
    const ids = memberships.map((m) => m._id);
    await posts.deleteAllByMembers(ids);
    await comments.deleteAllByMembers(ids);
    await media.release(
      memberships
        .flatMap((m) => [m.avatarMediaId, m.coverMediaId])
        .filter((id): id is Types.ObjectId => Boolean(id))
        .map(String),
    );
  });

  const resolvers: Record<ReportTarget, ReportTargetResolver> = {
    post: async (community, reporter, id) => {
      const post = await posts.findCommentable(community, reporter, id);
      return { targetId: post.id, ownerId: post.authorId };
    },
    comment: async (community, reporter, id) => {
      const comment = await comments.getVisible(community, reporter, id);
      return { targetId: comment.id, ownerId: comment.authorId };
    },
    member: async (community, _reporter, username) => {
      const member = await members.getByUsername(community._id, username);
      return { targetId: member.id, ownerId: member._id };
    },
    link: async (community, _reporter, code) => {
      if (!(await links.existsInCommunity(community._id, code))) throw AppError.notFound("Link not found");
      return { targetId: code };
    },
  };
  const actions: ReportActions = {
    hold: async (community, type, id) => {
      if (type === "post") await posts.holdForReports(community._id, new Types.ObjectId(id));
      if (type === "comment") await comments.holdForReports(community._id, new Types.ObjectId(id));
    },
    release: async (community, type, id) => {
      if (type === "post") await posts.releaseHold(community._id, new Types.ObjectId(id));
      if (type === "comment") await comments.releaseHold(community._id, new Types.ObjectId(id));
    },
    remove: async (community, actor, type, id, reason) => {
      if (type === "post") await posts.moderate(community, actor, id, "remove", reason);
      if (type === "comment") await comments.moderate(community, id, "remove", reason);
      if (type === "link") await links.blockLink(community._id, id);
    },
  };
  const reports = new ReportService(new ReportRepository(), resolvers, actions);

  return {
    members,
    social,
    notifications,
    posts,
    comments,
    reports,
    postPresenter: new PostPresenter(members, reactions, links),
    commentPresenter: new CommentPresenter(members, reactions, links),
  };
}

let services: ReturnType<typeof build> | undefined;
export const getServices = () => (services ??= build());

/** Everything under `/api/v1/communities/:community`. Resolves the community and the caller's membership first. */
export function createCommunityRouter() {
  const s = getServices();
  const router = Router({ mergeParams: true });
  router.use(createResolveCommunity(), attachMember);

  const comments = createCommentRoutes(s.comments, s.commentPresenter);
  router.use("/", createCommunityInfoRoutes());
  router.use("/posts", comments.postScoped, createPostRoutes(s.posts, s.postPresenter));
  router.use("/comments", comments.comments);
  router.use("/", createPostCompanionRoutes(s.posts, s.postPresenter));
  router.use("/members", createMemberRoutes(s.members, s.social));
  router.use("/notifications", createNotificationRoutes(s.notifications));
  router.use("/reports", createReportRoutes(s.reports));
  router.use("/media", createMediaRoutes());
  router.use("/links", createLinkApiRoutes());
  router.use("/moderation", createModerationRoutes());
  return router;
}
