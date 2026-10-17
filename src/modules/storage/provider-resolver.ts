import type { CredentialCipher } from "./crypto/credential-cipher.js";
import type { ProviderRegistry } from "./providers/provider.registry.js";
import type { AccountView, ProviderResolver, StorageProvider } from "./storage.types.js";

/** Decrypts an account's credentials once and keeps the resulting provider for reuse. */
export class CachedProviderResolver implements ProviderResolver {
  private readonly cache = new Map<string, StorageProvider>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly cipher: CredentialCipher,
  ) {}

  forAccount(account: AccountView): StorageProvider {
    let provider = this.cache.get(account.id);
    if (!provider) {
      const credentials: unknown = JSON.parse(this.cipher.decrypt(account.encryptedCredentials));
      provider = this.registry.create(account.provider, credentials);
      this.cache.set(account.id, provider);
    }
    return provider;
  }

  evict(accountId: string): void {
    this.cache.delete(accountId);
  }
}
