import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { z } from "zod";
import {
  QuotaExceededError,
  type DirectUploadProvider,
  type InspectedObject,
  type ProviderObject,
  type ProviderUsage,
  type UploadInput,
  type UploadTicket,
} from "../storage.types.js";
import type { ProviderDescriptor } from "./provider.registry.js";

export const cloudinaryCredentialsSchema = z.object({
  cloudName: z.string().min(1),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
});
export type CloudinaryCredentials = z.infer<typeof cloudinaryCredentialsSchema>;

/**
 * Cloudinary signals "out of quota" with 420 (rate/plan limit) or a message about the plan. This is a heuristic:
 * if a new wording shows up in production, extend the pattern.
 */
const QUOTA_MESSAGE = /quota|plan limit|credits|storage.*(exceeded|limit)|(exceeded|limit).*storage/i;
const QUOTA_HTTP_CODE = 420;

function isQuotaError(err: unknown): boolean {
  const e = err as { http_code?: number; message?: string; error?: { http_code?: number; message?: string } };
  const code = e?.http_code ?? e?.error?.http_code;
  const message = e?.message ?? e?.error?.message ?? "";
  return code === QUOTA_HTTP_CODE || QUOTA_MESSAGE.test(message);
}

/** Credentials are passed per call, never via cloudinary.config(), so many accounts can coexist safely. */
/** Cloudinary rejects signatures whose timestamp is older than an hour, so that is also our ticket lifetime. */
const TICKET_TTL_SECONDS = 60 * 60;

const FORMAT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export class CloudinaryProvider implements DirectUploadProvider {
  private readonly auth: { cloud_name: string; api_key: string; api_secret: string };

  constructor(credentials: CloudinaryCredentials) {
    this.auth = { cloud_name: credentials.cloudName, api_key: credentials.apiKey, api_secret: credentials.apiSecret };
  }

  upload(input: UploadInput): Promise<ProviderObject> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { ...this.auth, folder: input.folder, resource_type: "image", use_filename: false, unique_filename: true },
        (err, result?: UploadApiResponse) => {
          if (err || !result) return reject(isQuotaError(err) ? new QuotaExceededError(err?.message) : err);
          resolve({ key: result.public_id, url: result.secure_url });
        },
      );
      stream.end(input.data);
    });
  }

  /**
   * Signs exactly the parameters the client may use. The client cannot change `public_id` (so it cannot overwrite
   * another user's file) or `allowed_formats` without invalidating the signature, and the api_secret never leaves
   * the server: only the resulting signature does.
   */
  createUploadTicket({ key, allowedFormats }: { key: string; allowedFormats: string[] }): UploadTicket {
    const timestamp = Math.floor(Date.now() / 1000);
    const signed = { allowed_formats: allowedFormats.join(","), public_id: key, timestamp };
    return {
      method: "POST",
      url: `https://api.cloudinary.com/v1_1/${this.auth.cloud_name}/image/upload`,
      fields: {
        ...signed,
        api_key: this.auth.api_key,
        signature: cloudinary.utils.api_sign_request(signed, this.auth.api_secret),
      },
      fileField: "file",
      expiresAt: new Date((timestamp + TICKET_TTL_SECONDS) * 1000),
    };
  }

  async inspect(key: string): Promise<InspectedObject | null> {
    try {
      const r = await cloudinary.api.resource(key, { ...this.auth, resource_type: "image" });
      return { size: r.bytes, mimeType: FORMAT_TO_MIME[r.format] ?? `image/${r.format}`, url: r.secure_url };
    } catch (err) {
      const e = err as { http_code?: number; error?: { http_code?: number } };
      if ((e?.http_code ?? e?.error?.http_code) === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // "not found" is a successful outcome for an idempotent delete, so the result is not inspected.
    await cloudinary.uploader.destroy(key, { ...this.auth, resource_type: "image", invalidate: true });
  }

  async ping(): Promise<void> {
    await cloudinary.api.ping(this.auth);
  }

  async getUsage(): Promise<ProviderUsage> {
    const usage = await cloudinary.api.usage(this.auth);
    const bytes = usage?.storage?.usage;
    if (typeof bytes !== "number") throw new Error("Cloudinary did not report storage usage");
    return { usedBytes: bytes };
  }
}

export const cloudinaryDescriptor: ProviderDescriptor<CloudinaryCredentials> = {
  type: "cloudinary",
  credentialsSchema: cloudinaryCredentialsSchema,
  create: (credentials) => new CloudinaryProvider(credentials),
};
