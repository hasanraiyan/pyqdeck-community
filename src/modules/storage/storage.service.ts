import { StatusCodes } from "http-status-codes";
import { AppError } from "../../core/errors/AppError.js";
import { logger } from "../../core/utils/logger.js";
import { randomUUID } from "node:crypto";
import {
  QuotaExceededError,
  supportsDirectUpload,
  type AccountStore,
  type InspectedObject,
  type ProviderResolver,
  type ReservedFile,
  type StoredFile,
  type StoredFileRef,
  type UploadInput,
  type UploadTicket,
} from "./storage.types.js";

export class StorageFullError extends AppError {
  constructor() {
    super(StatusCodes.INSUFFICIENT_STORAGE, "Storage is full, please try again later");
  }
}

/** Safety valve: even with many accounts, one upload never walks the whole list forever. */
const MAX_ACCOUNT_ATTEMPTS = 5;

/**
 * Stores and removes files across any number of accounts. It knows nothing about Cloudinary, MongoDB or HTTP: it
 * only talks to the `AccountStore` and `ProviderResolver` abstractions.
 */
export class StorageService {
  constructor(
    private readonly accounts: AccountStore,
    private readonly resolver: ProviderResolver,
  ) {}

  async store(input: UploadInput): Promise<StoredFile> {
    const size = input.data.length;
    const tried: string[] = [];

    for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
      const account = await this.accounts.reserveSpace(size, tried);
      if (!account) break;

      try {
        const object = await this.resolver.forAccount(account).upload(input);
        return { accountId: account.id, provider: account.provider, key: object.key, url: object.url, size };
      } catch (err) {
        await this.accounts.release(account.id, size);
        if (!(err instanceof QuotaExceededError)) {
          logger.error({ err, accountId: account.id }, "storage upload failed");
          throw new AppError(StatusCodes.BAD_GATEWAY, "Could not store the file, please try again");
        }
        // This account is out of room: stop using it and fall through to the next one.
        logger.warn({ accountId: account.id }, "storage account over quota, marking full and failing over");
        await this.accounts.markFull(account.id);
        tried.push(account.id);
      }
    }

    logger.error({ size }, "no storage account has room: add a new account");
    throw new StorageFullError();
  }

  /**
   * Direct upload, step 1: reserve space on an account and hand back a ticket the client uploads with. The bytes
   * never touch our server. The reservation is held until `settle` (upload finished) or `remove` (abandoned).
   */
  async createUploadTicket(input: {
    sizeBytes: number;
    folder: string;
    allowedFormats: string[];
  }): Promise<{ file: ReservedFile; ticket: UploadTicket }> {
    const tried: string[] = [];
    let skippedUnsupported = false;

    for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
      const account = await this.accounts.reserveSpace(input.sizeBytes, tried);
      if (!account) break;

      const provider = this.resolver.forAccount(account);
      if (!supportsDirectUpload(provider)) {
        // This account cannot do direct uploads: give the space back and try the next one.
        await this.accounts.release(account.id, input.sizeBytes);
        tried.push(account.id);
        skippedUnsupported = true;
        continue;
      }

      try {
        const key = `${input.folder}/${randomUUID()}`;
        const ticket = provider.createUploadTicket({ key, allowedFormats: input.allowedFormats });
        return { file: { accountId: account.id, provider: account.provider, key, size: input.sizeBytes }, ticket };
      } catch (err) {
        await this.accounts.release(account.id, input.sizeBytes);
        logger.error({ err, accountId: account.id }, "could not create an upload ticket");
        throw new AppError(StatusCodes.BAD_GATEWAY, "Could not prepare the upload, please try again");
      }
    }

    if (skippedUnsupported) {
      throw new AppError(StatusCodes.NOT_IMPLEMENTED, "Direct upload is not available; use the multipart upload");
    }
    logger.error({ size: input.sizeBytes }, "no storage account has room: add a new account");
    throw new StorageFullError();
  }

  /** Direct upload, step 2: ask the provider what actually arrived. Null if nothing did. */
  async inspect(ref: { accountId: string; key: string }): Promise<InspectedObject | null> {
    const account = await this.accounts.findAccount(ref.accountId);
    if (!account) throw new Error(`Storage account ${ref.accountId} no longer exists`);
    const provider = this.resolver.forAccount(account);
    if (!supportsDirectUpload(provider)) throw new Error(`Provider ${account.provider} cannot inspect uploads`);
    return provider.inspect(ref.key);
  }

  /** Direct upload, step 3: the real size is known, so give back whatever was reserved beyond it. */
  async settle(accountId: string, reservedBytes: number, actualBytes: number): Promise<void> {
    if (actualBytes < reservedBytes) await this.accounts.release(accountId, reservedBytes - actualBytes);
  }

  async remove(ref: StoredFileRef): Promise<void> {
    const account = await this.accounts.findAccount(ref.accountId);
    if (!account) throw new Error(`Storage account ${ref.accountId} no longer exists`);
    await this.resolver.forAccount(account).delete(ref.key);
    await this.accounts.release(ref.accountId, ref.size);
  }
}
