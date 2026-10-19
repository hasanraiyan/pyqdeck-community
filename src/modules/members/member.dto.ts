import type { HydratedDocument } from "mongoose";
import type { LinkRef } from "../../core/ports/link-rewriter.js";
import type { IAccount } from "../accounts/account.model.js";
import type { IMember } from "./member.model.js";

type MemberDoc = HydratedDocument<IMember>;

/** Compact author shown on posts, comments and notifications. Deleted members render as "Deleted user" (FR-ACC-3). */
export function toAuthor(member: MemberDoc | undefined | null) {
  if (!member || member.status === "deleted") {
    return {
      id: member?.id ?? null,
      username: null,
      displayName: "Deleted user",
      avatarUrl: "",
      headline: "",
      role: "member" as const,
    };
  }
  return {
    id: member.id as string,
    username: member.username,
    displayName: member.displayName,
    avatarUrl: member.avatarUrl,
    headline: member.headline,
    role: member.role,
  };
}

export interface MemberExtras {
  websiteLink?: LinkRef | null;
  /** For the viewer; omitted on the viewer's own profile and for visitors. */
  isFollowing?: boolean;
}

/** Safe to show anyone. Never add email, account id or status here (FR-PRF-2, NFR-COMP-2). */
export function toPublicMember(member: MemberDoc, extras: MemberExtras = {}) {
  return {
    ...toAuthor(member),
    coverUrl: member.coverUrl,
    bio: member.bio,
    location: member.location,
    github: member.github,
    linkedin: member.linkedin,
    twitter: member.twitter,
    website: member.website,
    websiteLink: extras.websiteLink ?? null,
    skills: member.skills,
    attributes: member.attributes,
    followersCount: member.followersCount,
    followingCount: member.followingCount,
    postsCount: member.postsCount,
    upvotesCount: member.upvotesCount,
    joinedAt: member.createdAt,
    ...(extras.isFollowing !== undefined && { isFollowing: extras.isFollowing }),
  };
}

/** For the caller's own membership only: adds the private fields. */
export function toOwnMember(member: MemberDoc, account: HydratedDocument<IAccount>, extras: MemberExtras = {}) {
  return {
    ...toPublicMember(member, extras),
    email: account.email,
    status: member.status,
    suspendedUntil: member.suspendedUntil ?? null,
    isPlatformAdmin: account.platformRole === "admin",
  };
}
