import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDefaultRegistry } from "../../src/modules/storage/providers/index.js";
import { MemoryProvider } from "../../src/modules/storage/providers/memory.provider.js";
import { ProviderRegistry } from "../../src/modules/storage/providers/provider.registry.js";
import { QuotaExceededError, type StorageProvider } from "../../src/modules/storage/storage.types.js";

describe("ProviderRegistry", () => {
  it("is open for extension: a new provider is just a registered descriptor", async () => {
    class FakeUploadThing implements StorageProvider {
      constructor(readonly token: string) {}
      async upload() {
        return { key: "k", url: "https://utfs.io/f/k" };
      }
      async delete() {}
      async ping() {}
    }
    const registry = new ProviderRegistry().register({
      type: "uploadthing",
      credentialsSchema: z.object({ token: z.string().min(1) }),
      create: (c) => new FakeUploadThing(c.token),
    });

    expect(registry.has("uploadthing")).toBe(true);
    const provider = registry.create("uploadthing", { token: "t" });
    expect((await provider.upload({ data: Buffer.from("x"), fileName: "a", mimeType: "image/png" })).key).toBe("k");
  });

  it("validates credentials against the provider's own schema", () => {
    const registry = createDefaultRegistry({ allowMemory: true });
    expect(() => registry.create("cloudinary", { cloudName: "x" })).toThrow(); // missing apiKey/apiSecret
    expect(() => registry.create("cloudinary", { cloudName: "x", apiKey: "k", apiSecret: "s" })).not.toThrow();
  });

  it("rejects unknown provider types", () => {
    const registry = createDefaultRegistry({ allowMemory: true });
    expect(registry.has("nope")).toBe(false);
    expect(() => registry.create("nope", {})).toThrow('Unknown storage provider "nope"');
  });

  it("never offers the memory provider in production", () => {
    expect(createDefaultRegistry({ allowMemory: false }).types()).toEqual(["cloudinary"]);
    expect(createDefaultRegistry({ allowMemory: true }).types()).toEqual(["cloudinary", "memory"]);
  });
});

describe("MemoryProvider", () => {
  const file = (n: number) => ({ data: Buffer.alloc(n), fileName: "a", mimeType: "image/png" });

  it("stores, reports usage and deletes idempotently", async () => {
    const p = new MemoryProvider();
    const { key, url } = await p.upload(file(10));
    expect(url).toBe(`memory://${key}`);
    expect(await p.getUsage()).toEqual({ usedBytes: 10 });
    await p.delete(key);
    await p.delete(key); // second delete must not throw
    expect(await p.getUsage()).toEqual({ usedBytes: 0 });
  });

  it("throws QuotaExceededError past its quota", async () => {
    const p = new MemoryProvider({ quotaBytes: 15 });
    await p.upload(file(10));
    await expect(p.upload(file(10))).rejects.toBeInstanceOf(QuotaExceededError);
  });
});
