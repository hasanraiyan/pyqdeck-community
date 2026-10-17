import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors/AppError.js";
import { MemoryProvider } from "../../src/modules/storage/providers/memory.provider.js";
import { StorageFullError, StorageService } from "../../src/modules/storage/storage.service.js";
import { QuotaExceededError, type StorageProvider } from "../../src/modules/storage/storage.types.js";
import { FakeAccounts } from "../helpers/fake-accounts.js";

const file = (n = 100) => ({ data: Buffer.alloc(n), fileName: "a.png", mimeType: "image/png" });

/** A provider whose uploads always fail with the given error. */
const failing = (error: Error): StorageProvider => ({
  upload: async () => {
    throw error;
  },
  delete: async () => {},
  ping: async () => {},
});

let accounts: FakeAccounts;
let service: StorageService;
beforeEach(() => {
  accounts = new FakeAccounts();
  service = new StorageService(accounts, accounts);
});

describe("StorageService.store", () => {
  it("fills the lowest-priority-number account first and counts the bytes", async () => {
    accounts.add("b", { capacity: 1000, priority: 2 });
    accounts.add("a", { capacity: 1000, priority: 1 });

    const stored = await service.store(file(100));

    expect(stored).toMatchObject({ accountId: "a", provider: "memory", size: 100 });
    expect(stored.url).toMatch(/^memory:\/\//);
    expect(accounts.get("a").used).toBe(100);
    expect(accounts.get("b").used).toBe(0);
  });

  it("moves to the next account once the first has no room", async () => {
    accounts.add("a", { capacity: 150, priority: 1 });
    accounts.add("b", { capacity: 1000, priority: 2 });

    expect((await service.store(file(100))).accountId).toBe("a");
    expect((await service.store(file(100))).accountId).toBe("b"); // a has 50 left
  });

  it("skips disabled and full accounts", async () => {
    accounts.add("off", { capacity: 1000, priority: 1, status: "disabled" });
    accounts.add("full", { capacity: 1000, priority: 2, status: "full" });
    accounts.add("ok", { capacity: 1000, priority: 3 });

    expect((await service.store(file())).accountId).toBe("ok");
  });

  it("fails over when the provider reports quota exceeded, and retires that account", async () => {
    accounts.add("a", { capacity: 1000, priority: 1, provider: failing(new QuotaExceededError()) });
    accounts.add("b", { capacity: 1000, priority: 2 });

    const stored = await service.store(file(100));

    expect(stored.accountId).toBe("b");
    expect(accounts.get("a").status).toBe("full");
    expect(accounts.get("a").used).toBe(0); // reservation was given back
    expect(accounts.get("b").used).toBe(100);
  });

  it("does not use a retired account for later uploads", async () => {
    accounts.add("a", { capacity: 1000, priority: 1, provider: failing(new QuotaExceededError()) });
    accounts.add("b", { capacity: 1000, priority: 2 });

    await service.store(file());
    expect((await service.store(file())).accountId).toBe("b");
    expect(accounts.get("a").used).toBe(0);
  });

  it("returns 507 when every account is full", async () => {
    accounts.add("a", { capacity: 50 });
    accounts.add("b", { capacity: 50 });

    await expect(service.store(file(100))).rejects.toBeInstanceOf(StorageFullError);
    await expect(service.store(file(100))).rejects.toMatchObject({ statusCode: StatusCodes.INSUFFICIENT_STORAGE });
    expect(accounts.get("a").used + accounts.get("b").used).toBe(0);
  });

  it("returns 507 when there are no accounts at all", async () => {
    await expect(service.store(file())).rejects.toBeInstanceOf(StorageFullError);
  });

  it("returns 507 when failover runs out of accounts", async () => {
    accounts.add("a", { capacity: 1000, provider: failing(new QuotaExceededError()) });
    await expect(service.store(file())).rejects.toBeInstanceOf(StorageFullError);
    expect(accounts.get("a").status).toBe("full");
  });

  it("turns other provider failures into a 502 without retiring the account or leaking details", async () => {
    accounts.add("a", { capacity: 1000, provider: failing(new Error("api_secret=abc123 rejected")) });

    const err = await service.store(file()).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(StatusCodes.BAD_GATEWAY);
    expect(err.message).not.toContain("abc123");
    expect(accounts.get("a").status).toBe("active"); // a transient error must not close an account
    expect(accounts.get("a").used).toBe(0);
  });

  it("never over-allocates under concurrent uploads", async () => {
    accounts.add("a", { capacity: 1000, priority: 1 });
    accounts.add("b", { capacity: 1000, priority: 2 });

    const results = await Promise.allSettled(Array.from({ length: 30 }, () => service.store(file(100))));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
    expect(accounts.get("a").used).toBe(1000);
    expect(accounts.get("b").used).toBe(1000);
  });
});

describe("StorageService.remove", () => {
  it("deletes at the provider and frees the quota", async () => {
    const provider = new MemoryProvider();
    accounts.add("a", { capacity: 1000, provider });
    const stored = await service.store(file(100));
    expect(provider.objects.size).toBe(1);

    await service.remove(stored);

    expect(provider.objects.size).toBe(0);
    expect(accounts.get("a").used).toBe(0);
  });

  it("deletes from the account the file lives on, not the currently active one", async () => {
    const old = new MemoryProvider();
    accounts.add("old", { capacity: 150, priority: 1, provider: old });
    accounts.add("new", { capacity: 1000, priority: 2 });
    const first = await service.store(file(100)); // old
    await service.store(file(100)); // new (old has no room)

    await service.remove(first);

    expect(old.objects.size).toBe(0);
    expect(accounts.get("new").used).toBe(100);
  });

  it("keeps the quota counted if the provider delete fails, so it can be retried", async () => {
    const flaky: StorageProvider = {
      upload: async () => ({ key: "k", url: "u" }),
      delete: async () => {
        throw new Error("network");
      },
      ping: async () => {},
    };
    accounts.add("a", { capacity: 1000, provider: flaky });
    const stored = await service.store(file(100));

    await expect(service.remove(stored)).rejects.toThrow("network");
    expect(accounts.get("a").used).toBe(100);
  });

  it("fails loudly for an account that no longer exists", async () => {
    await expect(service.remove({ accountId: "ghost", key: "k", size: 1 })).rejects.toThrow("no longer exists");
  });
});
