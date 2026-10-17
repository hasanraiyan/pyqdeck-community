import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StorageAccountModel } from "../../src/modules/storage/storage-account.model.js";
import { StorageAccountRepository } from "../../src/modules/storage/storage-account.repository.js";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";

const repo = new StorageAccountRepository(0); // no headroom, so the arithmetic is exact

const makeAccount = (name: string, over: Record<string, unknown> = {}) =>
  StorageAccountModel.create({
    name,
    provider: "memory",
    credentials: "v1.x.y.z",
    capacityBytes: 1000,
    ...over,
  });

const used = async (name: string) => (await StorageAccountModel.findOne({ name }))!.usedBytes;

beforeAll(async () => {
  await connectTestDb();
  await StorageAccountModel.init();
});
afterAll(disconnectTestDb);
beforeEach(clearTestDb);

describe("StorageAccountRepository.reserveSpace", () => {
  it("is atomic: concurrent reservations can never exceed capacity", async () => {
    await makeAccount("a", { capacityBytes: 1000 });

    const results = await Promise.all(Array.from({ length: 40 }, () => repo.reserveSpace(100, [])));

    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await used("a")).toBe(1000);
  });

  it("fills accounts in priority order, then creation order", async () => {
    await makeAccount("low-priority", { priority: 5 });
    const first = await makeAccount("first", { priority: 1 });
    await makeAccount("second", { priority: 1 });

    expect((await repo.reserveSpace(10, []))?.id).toBe(first.id);
  });

  it("spills over to the next account when the first is full", async () => {
    await makeAccount("a", { priority: 1, capacityBytes: 100 });
    const b = await makeAccount("b", { priority: 2 });

    await repo.reserveSpace(100, []);
    expect((await repo.reserveSpace(50, []))?.id).toBe(b.id);
  });

  it("skips excluded, disabled and full accounts", async () => {
    const excluded = await makeAccount("excluded", { priority: 1 });
    await makeAccount("disabled", { priority: 2, status: "disabled" });
    await makeAccount("full", { priority: 3, status: "full" });
    const ok = await makeAccount("ok", { priority: 4 });

    expect((await repo.reserveSpace(10, [excluded.id]))?.id).toBe(ok.id);
  });

  it("returns null when nothing has room, without changing any counter", async () => {
    await makeAccount("a", { capacityBytes: 50 });
    expect(await repo.reserveSpace(100, [])).toBeNull();
    expect(await used("a")).toBe(0);
  });

  it("keeps headroom free", async () => {
    const withHeadroom = new StorageAccountRepository(0.1); // 10% kept free: 900 of 1000 usable
    await makeAccount("a");

    expect(await withHeadroom.reserveSpace(900, [])).not.toBeNull();
    expect(await withHeadroom.reserveSpace(1, [])).toBeNull();
  });

  it("returns the encrypted credentials for the resolver", async () => {
    await makeAccount("a", { credentials: "v1.secret.payload.here" });
    expect((await repo.reserveSpace(1, []))?.encryptedCredentials).toBe("v1.secret.payload.here");
  });
});

describe("StorageAccountRepository bookkeeping", () => {
  it("release gives space back but never goes below zero", async () => {
    const a = await makeAccount("a", { usedBytes: 100 });
    await repo.release(a.id, 30);
    expect(await used("a")).toBe(70);
    await repo.release(a.id, 9999);
    expect(await used("a")).toBe(0);
  });

  it("markFull only affects active accounts", async () => {
    const active = await makeAccount("active");
    const disabled = await makeAccount("disabled", { status: "disabled" });

    await repo.markFull(active.id);
    await repo.markFull(disabled.id);

    expect((await StorageAccountModel.findById(active.id))!.status).toBe("full");
    expect((await StorageAccountModel.findById(disabled.id))!.status).toBe("disabled");
  });

  it("does not expose credentials unless asked", async () => {
    const a = await makeAccount("a");
    expect((await StorageAccountModel.findById(a.id))!.credentials).toBeUndefined();
    expect(await repo.findAccount(a.id)).toMatchObject({ encryptedCredentials: "v1.x.y.z" });
    expect(await repo.findAccount("000000000000000000000000")).toBeNull();
  });
});
