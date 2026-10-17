import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../../../core/errors/AppError.js";

export interface CredentialCipher {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** AES-256-GCM. Payload format: `v1.<iv>.<tag>.<ciphertext>` (base64url). Tampering fails authentication. */
export class AesGcmCipher implements CredentialCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error(`Encryption key must be ${KEY_BYTES} bytes`);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), data]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(".");
    if (version !== VERSION || !iv || !tag || !data) throw new Error("Unrecognised credential payload");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  }
}

/** Used when no key is configured: the app still boots, but anything touching credentials fails with a clear error. */
class UnconfiguredCipher implements CredentialCipher {
  private fail(): never {
    throw AppError.internal("STORAGE_ENCRYPTION_KEY is not configured");
  }
  encrypt(): string {
    return this.fail();
  }
  decrypt(): string {
    return this.fail();
  }
}

/** `base64Key` must decode to exactly 32 bytes. Generate one with: `openssl rand -base64 32`. */
export function createCipher(base64Key?: string): CredentialCipher {
  return base64Key ? new AesGcmCipher(Buffer.from(base64Key, "base64")) : new UnconfiguredCipher();
}
