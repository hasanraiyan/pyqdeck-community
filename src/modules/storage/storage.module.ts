import { env } from "../../config/env.js";
import { createCipher } from "./crypto/credential-cipher.js";
import { CachedProviderResolver } from "./provider-resolver.js";
import { createDefaultRegistry } from "./providers/index.js";
import { StorageAccountRepository } from "./storage-account.repository.js";
import { StorageAdminService } from "./storage-admin.service.js";
import { StorageService } from "./storage.service.js";

/**
 * Composition root for storage: the only file that knows which concrete classes are wired together.
 * Everything else receives its dependencies through constructors.
 */
function build() {
  const headroom = env.STORAGE_HEADROOM_PERCENT / 100;
  const registry = createDefaultRegistry({ allowMemory: env.NODE_ENV !== "production" });
  const cipher = createCipher(env.STORAGE_ENCRYPTION_KEY);
  const repository = new StorageAccountRepository(headroom);
  const resolver = new CachedProviderResolver(registry, cipher);

  return {
    resolver,
    storage: new StorageService(repository, resolver),
    admin: new StorageAdminService(repository, registry, cipher, resolver, headroom),
  };
}

let instance: ReturnType<typeof build> | undefined;
const container = () => (instance ??= build());

export const getStorageService = () => container().storage;

const GB = 1024 ** 3;
export const ENV_STORAGE_ACCOUNT_NAME = "cloudinary-env";

/**
 * Creates or refreshes the Cloudinary account defined by CLOUDINARY_* variables. Does nothing when they are not all
 * set. A failure is reported to the caller rather than thrown, so a bad key never stops the server from starting.
 */
export async function bootstrapStorageFromEnv(): Promise<
  { status: "skipped" | "created" | "updated" | "unchanged" } | { status: "failed"; error: string }
> {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) return { status: "skipped" };
  try {
    const status = await container().admin.ensureAccount({
      name: ENV_STORAGE_ACCOUNT_NAME,
      provider: "cloudinary",
      credentials: {
        cloudName: env.CLOUDINARY_CLOUD_NAME,
        apiKey: env.CLOUDINARY_API_KEY,
        apiSecret: env.CLOUDINARY_API_SECRET,
      },
      capacityBytes: Math.floor(env.CLOUDINARY_CAPACITY_GB * GB),
      priority: 1,
    });
    return { status };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
export const getStorageAdminService = () => container().admin;
/** Exposed so tests can reach a provider instance (e.g. to simulate a client uploading straight to it). */
export const getProviderResolver = () => container().resolver;
