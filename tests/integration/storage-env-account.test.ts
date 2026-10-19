import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearTestDb, connectTestDb, disconnectTestDb } from "../helpers/db.js";

const { StorageAccountModel } = await import("../../src/modules/storage/storage-account.model.js");
const { getStorageAdminService } = await import("../../src/modules/storage/storage.module.js");

const GB = 1024 ** 3;
const account = (over: { quotaBytes?: number; capacityBytes?: number } = {}) => ({
  name: "from-env",
  provider: "memory",
  credentials: { quotaBytes: over.quotaBytes ?? 10 * GB },
  capacityBytes: over.capacityBytes ?? 2 * GB,
  priority: 1,
});

beforeAll(async () => {
  await connectTestDb();
  await StorageAccountModel.init();
});
afterAll(disconnectTestDb);
beforeEach(clearTestDb);

describe("ensureAccount (the account defined by environment variables)", () => {
  it("creates the account the first time and does nothing on later boots", async () => {
    const admin = getStorageAdminService();
    expect(await admin.ensureAccount(account())).toBe("created");
    expect(await admin.ensureAccount(account())).toBe("unchanged");
    expect(await StorageAccountModel.countDocuments()).toBe(1);
  });

  it("updates changed keys and capacity without losing usage or status", async () => {
    const admin = getStorageAdminService();
    await admin.ensureAccount(account());
    await StorageAccountModel.updateOne({ name: "from-env" }, { usedBytes: 12345, status: "disabled" });

    expect(await admin.ensureAccount(account({ quotaBytes: 20 * GB }))).toBe("updated");
    expect(await admin.ensureAccount(account({ quotaBytes: 20 * GB, capacityBytes: 4 * GB }))).toBe("updated");

    const stored = await StorageAccountModel.findOne({ name: "from-env" }).select("+credentials");
    expect(stored).toMatchObject({ usedBytes: 12345, status: "disabled", capacityBytes: 4 * GB });
    expect(stored!.credentials).not.toContain("quotaBytes"); // stored encrypted, never as plain JSON
  });

  it("refuses keys that do not work and keeps the old ones", async () => {
    const admin = getStorageAdminService();
    await admin.ensureAccount(account());
    const before = (await StorageAccountModel.findOne().select("+credentials"))!.credentials;

    await expect(
      admin.ensureAccount({ ...account(), credentials: { quotaBytes: "not a number" } }),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    expect((await StorageAccountModel.findOne().select("+credentials"))!.credentials).toBe(before);
  });
});
