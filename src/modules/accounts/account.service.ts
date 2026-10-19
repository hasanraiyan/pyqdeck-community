import type { HydratedDocument } from "mongoose";
import { env } from "../../config/env.js";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";
import { fetchClerkProfile, type ClerkProfile, type FetchClerkProfile } from "../auth/clerk.client.js";
import type { IAccount, PlatformRole } from "./account.model.js";
import { AccountRepository } from "./account.repository.js";

/** Runs after an account is deleted so each module can remove what it owns. Listeners must be idempotent. */
export type AccountDeletedListener = (account: HydratedDocument<IAccount>) => Promise<void>;

export class AccountService {
  private readonly listeners: AccountDeletedListener[] = [];

  constructor(
    private readonly repository = new AccountRepository(),
    private readonly fetchProfile: FetchClerkProfile = fetchClerkProfile,
    private readonly adminEmails: string[] = env.COMMUNITY_ADMIN_EMAILS,
  ) {}

  onDeleted(listener: AccountDeletedListener) {
    this.listeners.push(listener);
  }

  /** The account for a Clerk id, created on first sight. Null if Clerk has no usable account (e.g. no email). */
  async resolveFromClerk(clerkId: string): Promise<HydratedDocument<IAccount> | null> {
    const existing = await this.repository.findByClerkId(clerkId);
    if (existing) return existing;

    const profile = await this.fetchProfile(clerkId);
    if (!profile) return null;
    try {
      return await this.repository.create({
        clerkId,
        email: profile.email,
        platformRole: this.platformRoleFor(profile),
        clerkProfile: this.snapshot(profile),
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      return this.repository.findByClerkId(clerkId); // two first requests raced; the other won
    }
  }

  /** Webhook path: Clerk is the source of truth for the prefill snapshot and the email. */
  async syncFromClerk(clerkId: string) {
    const existing = await this.repository.findByClerkId(clerkId);
    if (!existing) return this.resolveFromClerk(clerkId);
    if (existing.status === "deleted") return existing;

    const profile = await this.fetchProfile(clerkId);
    if (!profile) return existing;
    const update: Record<string, unknown> = { email: profile.email, clerkProfile: this.snapshot(profile) };
    // Promote only: demotion is deliberate and done by hand, so editing the env never surprises anyone.
    if (existing.platformRole !== "admin" && this.platformRoleFor(profile) === "admin") update.platformRole = "admin";
    return this.repository.updateByClerkId(clerkId, update);
  }

  /** Clerk account deleted: scrub the account, then let every module remove its own data. */
  async markDeleted(clerkId: string) {
    const account = await this.repository.markDeleted(clerkId);
    if (!account) return null;
    for (const listener of this.listeners) await listener(account);
    return account;
  }

  private snapshot(profile: ClerkProfile) {
    return { username: profile.username, displayName: profile.displayName, avatarUrl: profile.avatarUrl };
  }

  private platformRoleFor(profile: ClerkProfile): PlatformRole {
    // An unverified email must never grant admin: anyone can claim an address they do not control.
    return profile.emailVerified && this.adminEmails.includes(profile.email) ? "admin" : "none";
  }
}
