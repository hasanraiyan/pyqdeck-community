/**
 * Contracts for the storage module. Everything else depends on these small interfaces, never on a concrete provider,
 * database model or SDK, so providers and persistence can be swapped without touching callers.
 */

export interface UploadInput {
  data: Buffer;
  fileName: string;
  mimeType: string;
  /** Logical folder inside the provider, e.g. "community/media". */
  folder?: string;
}

/** What a provider returns for a stored object. */
export interface ProviderObject {
  /** Provider-specific identifier, needed to delete the object later. */
  key: string;
  /** Publicly readable URL. */
  url: string;
}

export interface ProviderUsage {
  usedBytes: number;
}

/** A storage backend (Cloudinary, UploadThing, S3, ...). Implement this and register it; nothing else changes. */
export interface StorageProvider {
  upload(input: UploadInput): Promise<ProviderObject>;
  /** Must succeed when the object is already gone (idempotent). */
  delete(key: string): Promise<void>;
  /** Throws if the credentials do not work. Used to validate a new account. */
  ping(): Promise<void>;
  /** Optional: real usage as reported by the provider, used to correct our own accounting. */
  getUsage?(): Promise<ProviderUsage>;
}

/** Thrown by a provider when the account is out of space or over quota. Triggers failover to the next account. */
export class QuotaExceededError extends Error {
  constructor(message = "Storage quota exceeded") {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/** The part of a storage account the upload path needs. Deliberately free of any persistence detail. */
export interface AccountView {
  id: string;
  provider: string;
  /** Encrypted JSON credentials; only the provider resolver decrypts them. */
  encryptedCredentials: string;
}

/** Capacity bookkeeping for accounts. Reservation must be atomic so concurrent uploads cannot overshoot. */
export interface AccountStore {
  /** Reserves `sizeBytes` on the best account with room, skipping `excludeIds`. Null when none has room. */
  reserveSpace(sizeBytes: number, excludeIds: string[]): Promise<AccountView | null>;
  release(accountId: string, sizeBytes: number): Promise<void>;
  markFull(accountId: string): Promise<void>;
  findAccount(accountId: string): Promise<AccountView | null>;
}

/** Turns an account into a ready-to-use provider. */
export interface ProviderResolver {
  forAccount(account: AccountView): StorageProvider;
}

/** Result of a successful store. `size` is the amount counted against the account's quota. */
export interface StoredFile {
  accountId: string;
  provider: string;
  key: string;
  url: string;
  size: number;
}

/** Enough to find and delete a stored file later. */
export interface StoredFileRef {
  accountId: string;
  key: string;
  size: number;
}

/** Instructions the app follows to upload a file straight to the provider, bypassing our server. */
export interface UploadTicket {
  method: "POST";
  url: string;
  /** Form fields to send exactly as given (signature, key, ...), alongside the file. */
  fields: Record<string, string | number>;
  /** Name of the multipart field that carries the file. */
  fileField: string;
  expiresAt: Date;
}

/** What actually landed at the provider, as the provider itself reports it. */
export interface InspectedObject {
  size: number;
  mimeType: string;
  url: string;
}

/**
 * Optional capability: a provider that lets clients upload directly. Providers without it keep working through the
 * normal `upload()` path; callers check with `supportsDirectUpload`.
 */
export interface DirectUploadProvider extends StorageProvider {
  /** `key` is chosen by us so the client cannot pick (or overwrite) where its file goes. */
  createUploadTicket(input: { key: string; allowedFormats: string[] }): UploadTicket;
  /** Null when nothing has been uploaded under `key` (yet). */
  inspect(key: string): Promise<InspectedObject | null>;
}

export function supportsDirectUpload(provider: StorageProvider): provider is DirectUploadProvider {
  const p = provider as Partial<DirectUploadProvider>;
  return typeof p.createUploadTicket === "function" && typeof p.inspect === "function";
}

/** Space reserved for a file that a client is about to upload directly. */
export interface ReservedFile {
  accountId: string;
  provider: string;
  key: string;
  size: number;
}
