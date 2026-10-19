import type { HydratedDocument } from "mongoose";
import { ZodError } from "zod";
import { AppError } from "../../core/errors/AppError.js";
import { isDuplicateKeyError } from "../../core/utils/mongo.js";
import type { CredentialCipher } from "./crypto/credential-cipher.js";
import type { CachedProviderResolver } from "./provider-resolver.js";
import type { ProviderRegistry } from "./providers/provider.registry.js";
import type { IStorageAccount } from "./storage-account.model.js";
import type { StorageAccountRepository } from "./storage-account.repository.js";

export interface NewAccountInput {
  name: string;
  provider: string;
  credentials: unknown;
  capacityBytes: number;
  priority?: number;
}

export type AccountUpdate = Partial<Pick<IStorageAccount, "name" | "priority" | "capacityBytes" | "status">>;

/** Admin-facing view. Credentials never leave the server. */
export function toAccountView(doc: HydratedDocument<IStorageAccount>) {
  return {
    id: doc.id as string,
    name: doc.name,
    provider: doc.provider,
    status: doc.status,
    priority: doc.priority,
    capacityBytes: doc.capacityBytes,
    usedBytes: doc.usedBytes,
    usedPercent: Math.round((doc.usedBytes / doc.capacityBytes) * 1000) / 10,
    lastSyncedAt: doc.lastSyncedAt,
    createdAt: doc.createdAt,
  };
}

/** Account management: the "plug in a new account" workflow. Separate from the upload path on purpose. */
export class StorageAdminService {
  constructor(
    private readonly repository: StorageAccountRepository,
    private readonly registry: ProviderRegistry,
    private readonly cipher: CredentialCipher,
    private readonly resolver: CachedProviderResolver,
    private readonly headroom: number,
  ) {}

  providerTypes() {
    return this.registry.types();
  }

  async list() {
    return (await this.repository.findAllOrdered()).map(toAccountView);
  }

  async add(input: NewAccountInput) {
    if (!this.registry.has(input.provider)) {
      throw AppError.badRequest(`Unknown provider "${input.provider}"`, { available: this.registry.types() });
    }

    let credentials: unknown;
    try {
      credentials = this.registry.parseCredentials(input.provider, input.credentials);
    } catch (err) {
      if (err instanceof ZodError)
        throw AppError.badRequest("Invalid credentials for this provider", err.flatten().fieldErrors);
      throw err;
    }

    // Fail early with a clear message instead of discovering bad credentials on a user's first upload.
    try {
      await this.registry.create(input.provider, credentials).ping();
    } catch (err) {
      throw AppError.badRequest(`Could not connect to ${input.provider}: ${(err as Error).message ?? "unknown error"}`);
    }

    try {
      const doc = await this.repository.create({
        name: input.name,
        provider: input.provider,
        credentials: this.cipher.encrypt(JSON.stringify(credentials)),
        capacityBytes: input.capacityBytes,
        ...(input.priority !== undefined && { priority: input.priority }),
      });
      return toAccountView(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw AppError.conflict(`An account named "${input.name}" already exists`);
      throw err;
    }
  }

  /**
   * Makes sure an account described by configuration exists (the environment-defined account). Safe to run on every
   * boot: it creates the account if missing, updates the stored keys if they changed, and otherwise does nothing.
   * It never touches usage counters or the status, so a `full` or admin-disabled account stays that way.
   */
  async ensureAccount(input: NewAccountInput): Promise<"created" | "updated" | "unchanged"> {
    const existing = await this.repository.findByNameWithCredentials(input.name);
    if (!existing) {
      await this.add(input);
      return "created";
    }

    let credentials: unknown;
    try {
      credentials = this.registry.parseCredentials(input.provider, input.credentials);
    } catch (err) {
      if (err instanceof ZodError)
        throw AppError.badRequest("Invalid credentials for this provider", err.flatten().fieldErrors);
      throw err;
    }
    const same =
      existing.provider === input.provider && this.cipher.decrypt(existing.credentials) === JSON.stringify(credentials);
    if (same && existing.capacityBytes === input.capacityBytes) return "unchanged";

    if (!same) {
      // New keys are tested before they replace the old ones, so a typo in the environment cannot break working uploads.
      try {
        await this.registry.create(input.provider, credentials).ping();
      } catch (err) {
        throw AppError.badRequest(
          `Could not connect to ${input.provider}: ${(err as Error).message ?? "unknown error"}`,
        );
      }
      existing.provider = input.provider;
      existing.credentials = this.cipher.encrypt(JSON.stringify(credentials));
      this.resolver.evict(existing.id as string);
    }
    existing.capacityBytes = input.capacityBytes;
    await existing.save();
    return "updated";
  }

  async update(id: string, changes: AccountUpdate) {
    const doc = await this.repository.updateById(id, changes);
    if (!doc) throw AppError.notFound("Storage account not found");
    return toAccountView(doc);
  }

  /** Pulls the real usage from the provider, fixing any drift in our counter, and re-opens a `full` account that has room. */
  async refreshUsage(id: string) {
    const doc = await this.repository.findWithCredentials(id);
    if (!doc) throw AppError.notFound("Storage account not found");

    const provider = this.resolver.forAccount({
      id,
      provider: doc.provider,
      encryptedCredentials: doc.credentials,
    });
    if (!provider.getUsage) throw AppError.badRequest(`${doc.provider} does not report usage`);

    const { usedBytes } = await provider.getUsage();
    doc.usedBytes = usedBytes;
    doc.lastSyncedAt = new Date();
    if (doc.status === "full" && usedBytes < doc.capacityBytes * (1 - this.headroom)) doc.status = "active";
    await doc.save();

    return toAccountView(doc);
  }
}
