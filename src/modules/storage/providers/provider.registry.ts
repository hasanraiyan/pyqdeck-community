import type { ZodType } from "zod";
import type { StorageProvider } from "../storage.types.js";

/** Everything the system needs to know about a provider type: how to validate its credentials and build it. */
export interface ProviderDescriptor<C = unknown> {
  type: string;
  credentialsSchema: ZodType<C>;
  create(credentials: C): StorageProvider;
}

/** Open for extension: support a new provider by registering a descriptor. No existing code changes. */
export class ProviderRegistry {
  private readonly descriptors = new Map<string, ProviderDescriptor>();

  register<C>(descriptor: ProviderDescriptor<C>): this {
    this.descriptors.set(descriptor.type, descriptor as ProviderDescriptor);
    return this;
  }

  has(type: string): boolean {
    return this.descriptors.has(type);
  }

  types(): string[] {
    return [...this.descriptors.keys()];
  }

  /** Throws a ZodError for malformed credentials. */
  parseCredentials(type: string, raw: unknown): unknown {
    return this.get(type).credentialsSchema.parse(raw);
  }

  create(type: string, rawCredentials: unknown): StorageProvider {
    const descriptor = this.get(type);
    return descriptor.create(descriptor.credentialsSchema.parse(rawCredentials));
  }

  private get(type: string): ProviderDescriptor {
    const descriptor = this.descriptors.get(type);
    if (!descriptor) throw new Error(`Unknown storage provider "${type}"`);
    return descriptor;
  }
}
