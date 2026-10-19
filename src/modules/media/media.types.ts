/**
 * Ports owned by the media module. Media states what it needs; the storage module happens to satisfy `FileStorage`
 * structurally, so neither imports the other's internals.
 */

export interface StoredFileInfo {
  accountId: string;
  provider: string;
  key: string;
  url: string;
  size: number;
}

export interface FileStorage {
  store(input: { data: Buffer; fileName: string; mimeType: string; folder?: string }): Promise<StoredFileInfo>;
  remove(ref: { accountId: string; key: string; size: number }): Promise<void>;
}

export interface ValidatedFile {
  mimeType: string;
}

/** Decides whether a file's real content is acceptable. Swap it to allow other file kinds. */
export interface FileValidator {
  validate(buffer: Buffer): Promise<ValidatedFile>;
}

export interface UploadedFile {
  buffer: Buffer;
  originalName: string;
}

export interface Actor {
  id: string;
  communityId: string;
  role: "member" | "moderator" | "admin";
}

/** What the app needs to upload a file straight to the provider. */
export interface UploadTicket {
  method: "POST";
  url: string;
  fields: Record<string, string | number>;
  fileField: string;
  expiresAt: Date;
}

/** Optional storage capability for client-side uploads. The storage module satisfies it structurally. */
export interface DirectUploadStorage {
  createUploadTicket(input: {
    sizeBytes: number;
    folder: string;
    allowedFormats: string[];
  }): Promise<{ file: { accountId: string; provider: string; key: string; size: number }; ticket: UploadTicket }>;
  inspect(ref: { accountId: string; key: string }): Promise<{ size: number; mimeType: string; url: string } | null>;
  settle(accountId: string, reservedBytes: number, actualBytes: number): Promise<void>;
}

export interface DeclaredFile {
  mimeType: string;
  size: number;
}

export type ModeratedImage = { url: string } | { data: Buffer; mimeType: string };

/** Media states what it needs from moderation; it never imports the moderation module. */
export interface ImageModerator {
  check(
    image: ModeratedImage,
    context: { communityId: string; userId: string; sourceId?: string },
  ): Promise<{
    allowed: boolean;
    unavailable: boolean;
    /** Child-safety result: the file must be deleted at once. */
    escalate?: boolean;
  }>;
}
