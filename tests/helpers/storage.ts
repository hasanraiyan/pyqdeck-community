import type { MemoryProvider } from "../../src/modules/storage/providers/memory.provider.js";
import { StorageAccountModel } from "../../src/modules/storage/storage-account.model.js";
import { getProviderResolver } from "../../src/modules/storage/storage.module.js";

/** The in-memory provider behind an account, so a test can play the part of an app uploading straight to it. */
export async function providerOf(accountName: string): Promise<MemoryProvider> {
  const account = await StorageAccountModel.findOne({ name: accountName }).select("+credentials");
  return getProviderResolver().forAccount({
    id: account!.id,
    provider: account!.provider,
    encryptedCredentials: account!.credentials,
  }) as MemoryProvider;
}
