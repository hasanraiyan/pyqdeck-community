import { randomBytes, randomInt } from "node:crypto";
import type { HydratedDocument, Types } from "mongoose";
import { AppError } from "../../core/errors/AppError.js";
import type { ContentModerator } from "../../core/ports/content-moderator.js";
import type { LinkRef, LinkRewriter } from "../../core/ports/link-rewriter.js";
import type { MediaAttachments } from "../../core/ports/media-attachments.js";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";
import type { IAccount } from "../accounts/account.model.js";
import type { ICommunity } from "../communities/community.model.js";
import type { IMember } from "./member.model.js";
import type { MemberRepository } from "./member.repository.js";
import { memberMachine, type MemberRole } from "./member.states.js";

type MemberDoc = HydratedDocument<IMember>;

/** Clerk cannot reserve usernames, so we never adopt these as a handle (staff impersonation, FR-AUTH-4). */
const RESERVED_USERNAMES = new Set([
  "admin",
  "administrator",
  "moderator",
  "mod",
  "support",
  "help",
  "staff",
  "official",
  "system",
  "root",
  "pyqdeck",
  "api",
  "me",
  "settings",
  "login",
  "signup",
  "null",
  "undefined",
]);

export const HANDLE_PATTERN = /^[a-z0-9_.-]{3,30}$/;
const MAX_CREATE_ATTEMPTS = 4;

export type ProfileUpdate = Partial<
  Pick<
    IMember,
    | "username"
    | "displayName"
    | "headline"
    | "bio"
    | "location"
    | "github"
    | "linkedin"
    | "twitter"
    | "website"
    | "skills"
    | "attributes"
  >
> & { avatarMediaId?: string | null; coverMediaId?: string | null };

export class MemberService {
  constructor(
    private readonly repository: MemberRepository,
    private readonly moderator: ContentModerator,
    private readonly media: MediaAttachments,
    private readonly links: LinkRewriter,
  ) {}

  /** The caller's membership in this community, created on their first action there (FR-AUTH-2, FR-COM-6). */
  async ensureMember(community: HydratedDocument<ICommunity>, account: HydratedDocument<IAccount>) {
    const existing = await this.repository.findByAccount(community._id, account._id);
    if (existing) return existing;

    const profile = account.clerkProfile;
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
      try {
        return await this.repository.createIn(community._id, {
          accountId: account._id,
          displayName: profile.displayName || account.email.split("@")[0],
          avatarUrl: profile.avatarUrl,
          username: this.adoptableHandle(profile.username) ?? (await this.generateHandle(community._id, account.email)),
          role: account.platformRole === "admin" ? "admin" : "member",
        });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const winner = await this.repository.findByAccount(community._id, account._id);
        if (winner) return winner; // two first requests raced
        if (this.adoptableHandle(profile.username)) throw AppError.conflict("That handle is already taken here");
      }
    }
    throw AppError.conflict("Could not allocate a handle, please retry");
  }

  async getByUsername(communityId: Types.ObjectId, username: string) {
    const member = await this.repository.findByUsername(communityId, username);
    if (!member || member.status === "deleted") throw AppError.notFound("Member not found");
    return member;
  }

  getByIds(communityId: Types.ObjectId, ids: Array<string | Types.ObjectId>) {
    return this.repository.findManyIn(communityId, ids);
  }

  inactiveIds(communityId: Types.ObjectId) {
    return this.repository.inactiveIds(communityId);
  }

  async search(communityId: Types.ObjectId, q: string, limit = 20) {
    const pattern = new RegExp(`^${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    return this.repository.searchIn(communityId, pattern, limit);
  }

  /** Edits the caller's persona in this community. Free text is moderated first (FR-PRF-12). */
  async updateProfile(member: MemberDoc, input: ProfileUpdate) {
    const { avatarMediaId, coverMediaId, ...fields } = input;
    const update: Record<string, unknown> = { ...fields };

    if (fields.username !== undefined) {
      const handle = fields.username.toLowerCase();
      if (!HANDLE_PATTERN.test(handle) || RESERVED_USERNAMES.has(handle)) throw AppError.badRequest("Invalid handle");
      update.username = handle;
    }

    const text = [fields.displayName, fields.headline, fields.bio, fields.location, ...(fields.skills ?? [])]
      .filter(Boolean)
      .join("\n");
    if (text) await this.assertTextAllowed(member, text);

    const released: string[] = [];
    if (avatarMediaId !== undefined) {
      const [attached] = avatarMediaId
        ? await this.media.attach(member.communityId.toString(), member.id, [avatarMediaId])
        : [];
      if (member.avatarMediaId) released.push(member.avatarMediaId.toString());
      update.avatarMediaId = attached ? avatarMediaId : null;
      update.avatarUrl = attached?.url ?? "";
    }
    if (coverMediaId !== undefined) {
      const [attached] = coverMediaId
        ? await this.media.attach(member.communityId.toString(), member.id, [coverMediaId])
        : [];
      if (member.coverMediaId) released.push(member.coverMediaId.toString());
      update.coverMediaId = attached ? coverMediaId : null;
      update.coverUrl = attached?.url ?? "";
    }

    if (fields.website !== undefined && fields.website) {
      await this.links.sync({
        communityId: member.communityId.toString(),
        contentType: "profile",
        contentId: member.id,
        authorId: member.id,
        texts: [fields.website],
        maxLinks: 1,
        live: true,
      });
    }

    let updated: MemberDoc | null;
    try {
      updated = await this.repository.updateOneIn(member.communityId, { _id: member._id }, update);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw AppError.conflict("That handle is already taken here");
      throw err;
    }
    if (!updated) throw AppError.notFound("Member not found");
    if (released.length) await this.media.release(released);
    return updated;
  }

  /** The website as a short link (FR-PRF-4), keyed by member id. */
  async websiteLinks(members: MemberDoc[]): Promise<Map<string, LinkRef>> {
    const withSites = members.filter((m) => m.website);
    const rendered = await this.links.render(
      withSites.map((m) => ({ contentType: "profile" as const, contentId: m.id as string, text: m.website })),
    );
    const out = new Map<string, LinkRef>();
    for (const m of withSites) {
      const link = rendered.get(`profile:${m.id}`)?.links[0];
      if (link) out.set(m.id as string, { code: link.code, shortUrl: link.shortUrl, host: link.host });
    }
    return out;
  }

  async suspend(actor: MemberDoc, target: MemberDoc, reason: string, until?: Date) {
    this.assertCanModerate(actor, target);
    memberMachine.assertTransition(target.status, "suspended");
    const moved = await this.repository.transition(
      target.communityId,
      target._id,
      memberMachine.allowedFrom("suspended"),
      {
        status: "suspended",
        suspendedReason: reason,
        suspendedUntil: until,
      },
    );
    if (!moved) throw AppError.conflict("The member changed, please retry");
    return moved;
  }

  async unsuspend(actor: MemberDoc, target: MemberDoc) {
    this.assertCanModerate(actor, target);
    memberMachine.assertTransition(target.status, "active");
    const moved = await this.repository.updateOneIn(
      target.communityId,
      { _id: target._id, status: "suspended" },
      { status: "active", $unset: { suspendedUntil: 1, suspendedReason: 1 } },
    );
    if (!moved) throw AppError.conflict("The member changed, please retry");
    return moved;
  }

  async setRole(actor: MemberDoc, target: MemberDoc, role: MemberRole) {
    if (actor.role !== "admin") throw AppError.forbidden("Only a community admin can change roles");
    if (target.status === "deleted") throw AppError.notFound("Member not found");
    const updated = await this.repository.updateOneIn(target.communityId, { _id: target._id }, { role });
    if (!updated) throw AppError.notFound("Member not found");
    return updated;
  }

  /** Account deleted: scrub every membership of it, in every community. Returns them so content can be removed. */
  async scrubAccount(accountId: Types.ObjectId) {
    const memberships = await this.repository.findAllOfAccount(accountId);
    for (const m of memberships) await this.repository.scrub(m._id);
    return memberships;
  }

  /** A temporary suspension that has run out counts as active, without a background job to flip it. */
  isSuspended(member: Pick<IMember, "status" | "suspendedUntil">) {
    return member.status === "suspended" && !(member.suspendedUntil && member.suspendedUntil.getTime() <= Date.now());
  }

  adjustCounters(...args: Parameters<MemberRepository["inc"]>) {
    return this.repository.inc(...args);
  }

  private assertCanModerate(actor: MemberDoc, target: MemberDoc) {
    if (actor.id === target.id) throw AppError.badRequest("You cannot do this to yourself");
    if (target.status === "deleted") throw AppError.notFound("Member not found");
    const rank = { member: 0, moderator: 1, admin: 2 } as const;
    if (rank[target.role] >= rank[actor.role])
      throw AppError.forbidden("You cannot act on someone of equal or higher role");
  }

  private async assertTextAllowed(member: MemberDoc, text: string) {
    const verdict = await this.moderator.moderateText(text, {
      communityId: member.communityId.toString(),
      memberId: member.id,
      source: "profile",
    });
    if (verdict.degraded)
      throw AppError.serviceUnavailable("Checks are temporarily unavailable, please try again shortly");
    if (verdict.action !== "allow") throw AppError.unprocessable("This text may violate our community guidelines");
  }

  private adoptableHandle(username: string | null | undefined) {
    return username && HANDLE_PATTERN.test(username) && !RESERVED_USERNAMES.has(username) ? username : null;
  }

  private async generateHandle(communityId: Types.ObjectId, email: string) {
    let base = email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 24);
    if (base.length < 3) base = `user${base}`;
    if (RESERVED_USERNAMES.has(base)) base = `${base}_`;

    if (!(await this.repository.isUsernameTaken(communityId, base))) return base;
    for (let i = 0; i < 10; i++) {
      const candidate = `${base.slice(0, 25)}${randomInt(1000, 10000)}`;
      if (!(await this.repository.isUsernameTaken(communityId, candidate))) return candidate;
    }
    return `${base.slice(0, 20)}${randomBytes(4).toString("hex")}`;
  }
}
