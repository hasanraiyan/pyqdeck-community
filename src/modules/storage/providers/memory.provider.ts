import { randomUUID } from "node:crypto";
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

export const memoryCredentialsSchema = z.object({ quotaBytes: z.number().int().positive().optional() });
export type MemoryCredentials = z.infer<typeof memoryCredentialsSchema>;

/** In-process store for tests and local development. Data vanishes on restart, so it is never registered in production. */
export class MemoryProvider implements DirectUploadProvider {
  readonly objects = new Map<string, Buffer>();
  private readonly mimeTypes = new Map<string, string>();

  constructor(private readonly options: MemoryCredentials = {}) {}

  async upload(input: UploadInput): Promise<ProviderObject> {
    if (this.options.quotaBytes !== undefined && this.used() + input.data.length > this.options.quotaBytes) {
      throw new QuotaExceededError();
    }
    const key = `${input.folder ?? "root"}/${randomUUID()}`;
    this.objects.set(key, input.data);
    this.mimeTypes.set(key, input.mimeType);
    return { key, url: `memory://${key}` };
  }

  createUploadTicket({ key, allowedFormats }: { key: string; allowedFormats: string[] }): UploadTicket {
    return {
      method: "POST",
      url: "memory://upload",
      fields: { key, allowed_formats: allowedFormats.join(",") },
      fileField: "file",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
  }

  async inspect(key: string): Promise<InspectedObject | null> {
    const data = this.objects.get(key);
    if (!data) return null;
    return {
      size: data.length,
      mimeType: this.mimeTypes.get(key) ?? "application/octet-stream",
      url: `memory://${key}`,
    };
  }

  /** Test helper: stands in for the app uploading straight to the provider with a ticket. */
  simulateClientUpload(key: string, data: Buffer, mimeType: string): void {
    this.objects.set(key, data);
    this.mimeTypes.set(key, mimeType);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.mimeTypes.delete(key);
  }

  async ping(): Promise<void> {}

  async getUsage(): Promise<ProviderUsage> {
    return { usedBytes: this.used() };
  }

  private used(): number {
    let total = 0;
    for (const data of this.objects.values()) total += data.length;
    return total;
  }
}

export const memoryDescriptor: ProviderDescriptor<MemoryCredentials> = {
  type: "memory",
  credentialsSchema: memoryCredentialsSchema,
  create: (credentials) => new MemoryProvider(credentials),
};
