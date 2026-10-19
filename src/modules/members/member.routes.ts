import { Router, type Request, type Response } from "express";
import { AppError } from "../../core/errors/AppError.js";
import { rateLimit } from "../../core/middleware/rateLimit.js";
import { validate } from "../../core/middleware/validate.js";
import { cursorQuerySchema } from "../../core/utils/cursor.js";
import { sendCursorPage, sendNoContent, sendSuccess } from "../../core/utils/response.js";
import { requireAuth, requireRole } from "../auth/auth.middleware.js";
import type { SocialService } from "../social/social.service.js";
import { toOwnMember, toPublicMember } from "./member.dto.js";
import type { MemberService } from "./member.service.js";
import {
  searchMembersQuerySchema,
  setRoleSchema,
  suspendSchema,
  updateMemberSchema,
  usernameParamSchema,
} from "./member.schema.js";

const HOUR = 3_600_000;

export function createMemberRoutes(members: MemberService, social: SocialService) {
  const router = Router({ mergeParams: true });
  const byName = validate({ params: usernameParamSchema });

  /** A member as the viewer may see them: unknown, deleted and blocked-either-way all look the same (404). */
  const target = async (req: Request) => {
    const found = await members.getByUsername(req.community!._id, String(req.params.username));
    if (req.member && !req.member._id.equals(found._id) && (await social.isBlockedEitherWay(req.member, found._id))) {
      throw AppError.notFound("Member not found");
    }
    return found;
  };

  router.get("/search", validate({ query: searchMembersQuerySchema }), async (req, res) => {
    const { q, limit } = res.locals.query;
    const found = await members.search(req.community!._id, q, limit);
    const hidden = new Set((req.member ? await social.hiddenFrom(req.member) : []).map(String));
    sendSuccess(
      res,
      found.filter((m) => !hidden.has(m.id)).map((m) => toPublicMember(m)),
    );
  });

  router.get("/me", requireAuth, async (req, res) => {
    const links = await members.websiteLinks([req.member!]);
    sendSuccess(res, toOwnMember(req.member!, req.account!, { websiteLink: links.get(req.member!.id) }));
  });
  router.patch("/me", requireAuth, validate({ body: updateMemberSchema }), async (req, res) => {
    const updated = await members.updateProfile(req.member!, req.body);
    const links = await members.websiteLinks([updated]);
    sendSuccess(res, toOwnMember(updated, req.account!, { websiteLink: links.get(updated.id) }));
  });
  router.get("/me/blocked", requireAuth, validate({ query: cursorQuerySchema }), async (req, res) => {
    const { cursor, limit } = res.locals.query;
    const page = await social.listBlocked(req.member!, cursor, limit);
    sendCursorPage(
      res,
      page.items.map((m) => toPublicMember(m)),
      page,
    );
  });

  router.get("/:username", byName, async (req, res) => {
    const found = await target(req);
    const [links, following] = await Promise.all([
      members.websiteLinks([found]),
      req.member && !req.member._id.equals(found._id) ? social.isFollowing(req.member, found._id) : undefined,
    ]);
    sendSuccess(res, toPublicMember(found, { websiteLink: links.get(found.id), isFollowing: following }));
  });

  const list = (side: "followers" | "following") => async (req: Request, res: Response) => {
    const found = await target(req);
    const { cursor, limit } = res.locals.query;
    const page =
      side === "followers"
        ? await social.listFollowers(found, cursor, limit)
        : await social.listFollowing(found, cursor, limit);
    sendCursorPage(
      res,
      page.items.map((m) => toPublicMember(m)),
      page,
    );
  };
  router.get(
    "/:username/followers",
    validate({ params: usernameParamSchema, query: cursorQuerySchema }),
    list("followers"),
  );
  router.get(
    "/:username/following",
    validate({ params: usernameParamSchema, query: cursorQuerySchema }),
    list("following"),
  );

  const followLimit = rateLimit({ limit: 100, windowMs: HOUR });
  router.put("/:username/follow", requireAuth, followLimit, byName, async (req, res) => {
    const found = await target(req);
    await social.follow(req.member!, found);
    const fresh = await members.getByUsername(req.community!._id, found.username);
    sendSuccess(res, { isFollowing: true, followersCount: fresh.followersCount });
  });
  router.delete("/:username/follow", requireAuth, followLimit, byName, async (req, res) => {
    const found = await target(req);
    await social.unfollow(req.member!, found);
    const fresh = await members.getByUsername(req.community!._id, found.username);
    sendSuccess(res, { isFollowing: false, followersCount: fresh.followersCount });
  });

  router.put("/:username/block", requireAuth, byName, async (req, res) => {
    const found = await members.getByUsername(req.community!._id, String(req.params.username));
    await social.block(req.member!, found);
    sendNoContent(res);
  });
  router.delete("/:username/block", requireAuth, byName, async (req, res) => {
    const found = await members.getByUsername(req.community!._id, String(req.params.username));
    await social.unblock(req.member!, found);
    sendNoContent(res);
  });

  // Moderation of people. The service checks rank, so a moderator cannot act on a peer or an admin.
  router.put(
    "/:username/suspend",
    requireAuth,
    requireRole("moderator"),
    validate({ params: usernameParamSchema, body: suspendSchema }),
    async (req, res) => {
      const found = await members.getByUsername(req.community!._id, String(req.params.username));
      await members.suspend(req.member!, found, req.body.reason, req.body.until);
      sendNoContent(res);
    },
  );
  router.delete("/:username/suspend", requireAuth, requireRole("moderator"), byName, async (req, res) => {
    const found = await members.getByUsername(req.community!._id, String(req.params.username));
    await members.unsuspend(req.member!, found);
    sendNoContent(res);
  });
  router.put(
    "/:username/role",
    requireAuth,
    requireRole("admin"),
    validate({ params: usernameParamSchema, body: setRoleSchema }),
    async (req, res) => {
      const found = await members.getByUsername(req.community!._id, String(req.params.username));
      const updated = await members.setRole(req.member!, found, req.body.role);
      sendSuccess(res, { username: updated.username, role: updated.role });
    },
  );

  return router;
}
