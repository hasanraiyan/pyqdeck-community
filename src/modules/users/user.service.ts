import { randomBytes, randomInt } from "node:crypto";
import type { HydratedDocument } from "mongoose";
import { env } from "../../config/env.js";
import { BaseService } from "../../core/base/BaseService.js";
import { AppError } from "../../core/errors/AppError.js";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";
import { fetchClerkProfile, type ClerkProfile, type FetchClerkProfile } from "../auth/clerk.client.js";
import type { IUser, UserRole } from "./user.model.js";
import { UserRepository } from "./user.repository.js";

/** Clerk cannot reserve usernames, so we never adopt these as a community handle (staff impersonation). */
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

const MAX_CREATE_ATTEMPTS = 4;

/** The only fields a user edits here; identity fields (username, name, avatar) are managed in Clerk. */
export type ProfileUpdate = Partial<Pick<IUser, "headline" | "bio">>;

export class UserService extends BaseService<IUser, UserRepository> {
  constructor(
    repository = new UserRepository(),
    private readonly fetchProfile: FetchClerkProfile = fetchClerkProfile,
    private readonly adminEmails: string[] = env.COMMUNITY_ADMIN_EMAILS,
  ) {
    super(repository, "User");
  }

  /** Returns the community profile for a Clerk id, creating it on first sight. Null if Clerk has no usable account. */
  async resolveFromClerk(clerkId: string): Promise<HydratedDocument<IUser> | null> {
    const existing = await this.repository.findByClerkId(clerkId);
    if (existing) return existing;

    const profile = await this.fetchProfile(clerkId);
    if (!profile) return null;

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
      try {
        return await this.repository.create({
          clerkId,
          email: profile.email,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          username: this.adoptableUsername(profile) ?? (await this.generateUsername(profile.email)),
          role: this.roleFor(profile),
        });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // Two first requests raced and the other one won, or a generated handle was taken a moment ago.
        const winner = await this.repository.findByClerkId(clerkId);
        if (winner) return winner;
        if (this.adoptableUsername(profile)) throw AppError.conflict("Username is already in use by another account");
      }
    }
    throw AppError.conflict("Could not allocate a username, please retry");
  }

  /** Webhook path: Clerk is the source of truth for identity fields, so overwrite them from Clerk. */
  async syncFromClerk(clerkId: string) {
    const existing = await this.repository.findByClerkId(clerkId);
    if (!existing) return this.resolveFromClerk(clerkId);
    if (existing.status === "deleted") return existing;

    const profile = await this.fetchProfile(clerkId);
    if (!profile) return existing;

    const update: Partial<IUser> = {
      email: profile.email,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
    };
    // Promote only: demotion is deliberate and done by hand, so removing an email from the env never surprises anyone.
    if (existing.role !== "admin" && this.roleFor(profile) === "admin") update.role = "admin";

    const username = this.adoptableUsername(profile);
    try {
      return await this.repository.updateByClerkId(clerkId, username ? { ...update, username } : update);
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // The new Clerk username clashes with a handle we generated for someone else. Keep the old one for now and
      // still apply the rest, rather than failing the webhook forever.
      return this.repository.updateByClerkId(clerkId, update);
    }
  }

  /** Clerk account deleted: keep the row (future posts reference it) but scrub personal data and free the handle. */
  async markDeleted(clerkId: string) {
    const existing = await this.repository.findByClerkId(clerkId);
    if (!existing || existing.status === "deleted") return null;

    return this.repository.updateByClerkId(clerkId, {
      status: "deleted",
      username: `deleted_${randomBytes(4).toString("hex")}`,
      displayName: "Deleted user",
      email: `deleted+${randomBytes(6).toString("hex")}@invalid.local`,
      avatarUrl: "",
      headline: "",
      bio: "",
    });
  }

  updateProfile(user: HydratedDocument<IUser>, input: ProfileUpdate) {
    return this.update(user.id, input);
  }

  async getByUsername(username: string) {
    const user = await this.repository.findByUsername(username);
    if (!user || user.status === "deleted") throw AppError.notFound("User not found");
    return user;
  }

  /** The Clerk username if we can show it as a handle, else null (missing or reserved). */
  private adoptableUsername(profile: ClerkProfile) {
    return profile.username && !RESERVED_USERNAMES.has(profile.username) ? profile.username : null;
  }

  private roleFor(profile: ClerkProfile): UserRole {
    // An unverified email must never grant admin: anyone can claim an address they do not control.
    return profile.emailVerified && this.adminEmails.includes(profile.email) ? "admin" : "member";
  }

  /** Fallback for Clerk accounts without a username. */
  private async generateUsername(email: string) {
    let base = email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 24);
    if (base.length < 3) base = `user${base}`;
    if (RESERVED_USERNAMES.has(base)) base = `${base}_`;

    if (!(await this.repository.isUsernameTaken(base))) return base;
    for (let i = 0; i < 10; i++) {
      const candidate = `${base.slice(0, 25)}${randomInt(1000, 10000)}`;
      if (!(await this.repository.isUsernameTaken(candidate))) return candidate;
    }
    return `${base.slice(0, 20)}${randomBytes(4).toString("hex")}`;
  }
}
