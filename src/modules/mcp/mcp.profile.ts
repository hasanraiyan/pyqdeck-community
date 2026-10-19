import type { HydratedDocument } from "mongoose";
import { z } from "zod";
import { AppError } from "../../core/errors/AppError.js";
import type { IAccount } from "../accounts/account.model.js";
import type { AccountService } from "../accounts/account.service.js";
import type { CommunityService } from "../communities/community.service.js";
import { toOwnMember, toPublicMember } from "../members/member.dto.js";
import type { IMember } from "../members/member.model.js";
import { updateMemberSchema } from "../members/member.schema.js";
import type { MemberService } from "../members/member.service.js";
import type { SocialService } from "../social/social.service.js";

type MemberDoc = HydratedDocument<IMember>;

export const PROFILE_ACTIONS = ["read", "search", "update", "patch", "clear"] as const;
export type ProfileAction = (typeof PROFILE_ACTIONS)[number];

/** What `clear` can empty. Each maps to the value the profile API uses for "nothing". */
export const CLEARABLE_FIELDS = {
  headline: "",
  bio: "",
  location: "",
  github: "",
  linkedin: "",
  twitter: "",
  website: "",
  skills: [],
  avatar: null,
  cover: null,
} as const;
export type ClearableField = keyof typeof CLEARABLE_FIELDS;

export const DEFAULT_COMMUNITY = "beu";

/** Everything the single `manage_profile` tool accepts. Which fields matter depends on `action`. */
export const profileInputShape = {
  action: z
    .enum(PROFILE_ACTIONS)
    .describe(
      "read: your profile, or another member's when `handle` is given. search: find members by `q`. " +
        "patch: change ONLY the fields you send. update: replace the whole editable profile (needs displayName; any text field you leave out is emptied). " +
        "clear: empty the named `fields`.",
    ),
  community: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe(`Community slug. Defaults to "${DEFAULT_COMMUNITY}".`),
  handle: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("read: the @username of another member (leave out for yourself)."),
  q: z.string().trim().min(1).max(60).optional().describe("search: start of a name or username."),
  limit: z.number().int().min(1).max(20).optional().describe("search: how many members to return (default 10)."),
  newUsername: z.string().trim().max(30).optional().describe("Change your @username (3-30 characters)."),
  displayName: z.string().trim().max(80).optional(),
  headline: z.string().trim().max(120).optional().describe("One line under your name."),
  bio: z.string().trim().max(500).optional(),
  location: z.string().trim().max(80).optional(),
  github: z.string().trim().max(300).optional().describe("A username or profile link."),
  linkedin: z.string().trim().max(300).optional().describe("A username or profile link."),
  twitter: z.string().trim().max(300).optional().describe("An X (Twitter) username or profile link."),
  website: z.string().trim().max(2048).optional().describe("A web address; https:// is added if missing."),
  skills: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  fields: z
    .array(z.enum(Object.keys(CLEARABLE_FIELDS) as [ClearableField, ...ClearableField[]]))
    .min(1)
    .optional()
    .describe("clear: which parts of the profile to empty."),
};
export const profileInputSchema = z.object(profileInputShape);
export type ProfileInput = z.infer<typeof profileInputSchema>;

/** Text fields that `update` empties when they are not sent. */
const REPLACED_TEXT_FIELDS = ["headline", "bio", "location", "github", "linkedin", "twitter", "website"] as const;
const EDITABLE_FIELDS = [...REPLACED_TEXT_FIELDS, "displayName", "skills"] as const;

export interface ProfileToolDeps {
  accounts: Pick<AccountService, "resolveFromClerk">;
  communities: Pick<CommunityService, "getBySlug">;
  members: MemberService;
  social: Pick<SocialService, "isBlockedEitherWay" | "hiddenFrom">;
}

/**
 * The `manage_profile` tool, independent of MCP transport and auth: it is given the Clerk user id of whoever
 * authorized the call and works as that person's membership. It reuses the same services as the HTTP API, so every rule
 * there (moderation of free text, handle checks, blocks, suspension) applies here too.
 */
export class ProfileTool {
  constructor(private readonly deps: ProfileToolDeps) {}

  async run(clerkId: string | undefined, input: ProfileInput): Promise<unknown> {
    if (!clerkId) throw AppError.unauthorized("Sign in to use this tool");
    const account = await this.deps.accounts.resolveFromClerk(clerkId);
    if (!account || account.status !== "active") throw AppError.unauthorized("Sign in to use this tool");

    const community = await this.deps.communities.getBySlug((input.community ?? DEFAULT_COMMUNITY).toLowerCase());
    if (community.status === "disabled") throw AppError.notFound("Community not found");
    const writes = input.action === "update" || input.action === "patch" || input.action === "clear";
    if (writes && community.status === "read_only") throw AppError.forbidden("This community is read-only right now");

    const member = await this.deps.members.ensureMember(community, account);
    if (member.status === "deleted") throw AppError.unauthorized("Sign in to use this tool");
    const suspended =
      member.status === "suspended" && !(member.suspendedUntil && member.suspendedUntil.getTime() <= Date.now());
    if (suspended) throw AppError.forbidden("Your account is suspended");

    switch (input.action) {
      case "read":
        return input.handle ? this.readOther(member, input.handle) : this.own(member, account);
      case "search":
        return this.search(member, input);
      case "patch":
        return this.save(member, account, this.patchBody(input));
      case "update":
        return this.save(member, account, this.replaceBody(input));
      case "clear":
        return this.save(member, account, this.clearBody(input));
    }
  }

  private async own(member: MemberDoc, account: HydratedDocument<IAccount>) {
    const links = await this.deps.members.websiteLinks([member]);
    return toOwnMember(member, account, { websiteLink: links.get(member.id) });
  }

  private async readOther(viewer: MemberDoc, handle: string) {
    const found = await this.deps.members.getByUsername(viewer.communityId, handle.replace(/^@/, "").toLowerCase());
    if (!viewer._id.equals(found._id) && (await this.deps.social.isBlockedEitherWay(viewer, found._id))) {
      throw AppError.notFound("Member not found");
    }
    const links = await this.deps.members.websiteLinks([found]);
    return toPublicMember(found, { websiteLink: links.get(found.id) });
  }

  private async search(viewer: MemberDoc, input: ProfileInput) {
    if (!input.q) throw AppError.badRequest("search needs `q`");
    const found = await this.deps.members.search(viewer.communityId, input.q, input.limit ?? 10);
    const hidden = new Set((await this.deps.social.hiddenFrom(viewer)).map(String));
    return found.filter((m) => !hidden.has(m.id)).map((m) => toPublicMember(m));
  }

  /** `patch`: exactly what was sent. */
  private patchBody(input: ProfileInput): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const key of EDITABLE_FIELDS) if (input[key] !== undefined) body[key] = input[key];
    if (input.newUsername !== undefined) body.username = input.newUsername;
    if (Object.keys(body).length === 0) throw AppError.badRequest("patch needs at least one field to change");
    return body;
  }

  /** `update`: the whole editable profile. Whatever was left out is emptied, so a mistake cannot half-apply. */
  private replaceBody(input: ProfileInput): Record<string, unknown> {
    if (!input.displayName) throw AppError.badRequest("update replaces the whole profile and needs displayName");
    const body: Record<string, unknown> = { displayName: input.displayName, skills: input.skills ?? [] };
    for (const key of REPLACED_TEXT_FIELDS) body[key] = input[key] ?? "";
    if (input.newUsername !== undefined) body.username = input.newUsername;
    return body;
  }

  private clearBody(input: ProfileInput): Record<string, unknown> {
    if (!input.fields?.length) throw AppError.badRequest("clear needs `fields`");
    const body: Record<string, unknown> = {};
    for (const field of new Set(input.fields)) {
      if (field === "avatar") body.avatarMediaId = null;
      else if (field === "cover") body.coverMediaId = null;
      else body[field] = CLEARABLE_FIELDS[field];
    }
    return body;
  }

  private async save(member: MemberDoc, account: HydratedDocument<IAccount>, body: Record<string, unknown>) {
    const parsed = updateMemberSchema.safeParse(body);
    if (!parsed.success) {
      throw AppError.badRequest(
        parsed.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; "),
      );
    }
    const updated = await this.deps.members.updateProfile(member, parsed.data);
    return this.own(updated, account);
  }
}
