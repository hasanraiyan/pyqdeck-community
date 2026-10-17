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
export const getStorageAdminService = () => container().admin;
/** Exposed so tests can reach a provider instance (e.g. to simulate a client uploading straight to it). */
export const getProviderResolver = () => container().resolver;
