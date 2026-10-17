import { MemoryProvider } from "../../src/modules/storage/providers/memory.provider.js";
import type {
  AccountStore,
  AccountView,
  ProviderResolver,
  StorageProvider,
} from "../../src/modules/storage/storage.types.js";

export interface FakeAccount {
  id: string;
  capacity: number;
  used: number;
  status: "active" | "full" | "disabled";
  priority: number;
  provider: StorageProvider;
}

/** In-memory AccountStore with the same reservation semantics as the real one, for DB-free unit tests. */
export class FakeAccounts implements AccountStore, ProviderResolver {
  readonly accounts: FakeAccount[] = [];

  add(
    id: string,
    opts: { capacity: number; priority?: number; provider?: StorageProvider; status?: FakeAccount["status"] },
  ) {
    const account: FakeAccount = {
      id,
      capacity: opts.capacity,
      used: 0,
      status: opts.status ?? "active",
      priority: opts.priority ?? 100,
      provider: opts.provider ?? new MemoryProvider(),
    };
    this.accounts.push(account);
    return account;
  }

  get(id: string) {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) throw new Error(`no fake account ${id}`);
    return account;
  }

  async reserveSpace(size: number, exclude: string[]): Promise<AccountView | null> {
    const found = [...this.accounts]
      .sort((a, b) => a.priority - b.priority)
      .find((a) => a.status === "active" && !exclude.includes(a.id) && a.used + size <= a.capacity);
    if (!found) return null;
    found.used += size;
    return this.view(found);
  }

  async release(id: string, size: number) {
    const a = this.get(id);
    a.used = Math.max(0, a.used - size);
  }

  async markFull(id: string) {
    const a = this.get(id);
    if (a.status === "active") a.status = "full";
  }

  async findAccount(id: string) {
    const a = this.accounts.find((x) => x.id === id);
    return a ? this.view(a) : null;
  }

  forAccount(account: AccountView) {
    return this.get(account.id).provider;
  }

  private view(a: FakeAccount): AccountView {
    return { id: a.id, provider: "memory", encryptedCredentials: "" };
  }
}
