import { v2 as cloudinary } from "cloudinary";
import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it } from "vitest";
import { CloudinaryProvider } from "../../src/modules/storage/providers/cloudinary.provider.js";
import { MemoryProvider } from "../../src/modules/storage/providers/memory.provider.js";
import { StorageFullError, StorageService } from "../../src/modules/storage/storage.service.js";
import { supportsDirectUpload, type StorageProvider } from "../../src/modules/storage/storage.types.js";
import { FakeAccounts } from "../helpers/fake-accounts.js";

describe("CloudinaryProvider.createUploadTicket", () => {
  const provider = new CloudinaryProvider({ cloudName: "demo", apiKey: "the-key", apiSecret: "the-secret" });
  const ticket = provider.createUploadTicket({ key: "folder/abc", allowedFormats: ["jpg", "png"] });

  it("points the app straight at Cloudinary", () => {
    expect(ticket.method).toBe("POST");
    expect(ticket.url).toBe("https://api.cloudinary.com/v1_1/demo/image/upload");
    expect(ticket.fileField).toBe("file");
  });

  it("pins the destination and allowed formats the client may use", () => {
    expect(ticket.fields).toMatchObject({ public_id: "folder/abc", allowed_formats: "jpg,png", api_key: "the-key" });
  });

  it("never leaks the api secret", () => {
    expect(JSON.stringify(ticket)).not.toContain("the-secret");
  });

  it("carries a signature that Cloudinary will accept, and that breaks if the client edits a field", () => {
    const { signature, api_key: _apiKey, ...signed } = ticket.fields;
    expect(signature).toBe(cloudinary.utils.api_sign_request(signed, "the-secret"));
    // Changing where the file goes, or which formats are allowed, invalidates the signature.
    expect(cloudinary.utils.api_sign_request({ ...signed, public_id: "someone/elses" }, "the-secret")).not.toBe(
      signature,
    );
    expect(cloudinary.utils.api_sign_request({ ...signed, allowed_formats: "exe" }, "the-secret")).not.toBe(signature);
  });

  it("expires in about an hour", () => {
    const ms = ticket.expiresAt.getTime() - Date.now();
    expect(ms).toBeGreaterThan(59 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("is recognised as direct-upload capable", () => {
    expect(supportsDirectUpload(provider)).toBe(true);
    expect(supportsDirectUpload(new MemoryProvider())).toBe(true);
    const plain: StorageProvider = {
      upload: async () => ({ key: "k", url: "u" }),
      delete: async () => {},
      ping: async () => {},
    };
    expect(supportsDirectUpload(plain)).toBe(false);
  });
});

const request = { sizeBytes: 100, folder: "media", allowedFormats: ["png"] };
const noDirect: StorageProvider = {
  upload: async () => ({ key: "k", url: "u" }),
  delete: async () => {},
  ping: async () => {},
};

let accounts: FakeAccounts;
let service: StorageService;
beforeEach(() => {
  accounts = new FakeAccounts();
  service = new StorageService(accounts, accounts);
});

describe("StorageService.createUploadTicket", () => {
  it("reserves space and returns a ticket for a key under the requested folder", async () => {
    accounts.add("a", { capacity: 1000 });

    const { file, ticket } = await service.createUploadTicket(request);

    expect(file).toMatchObject({ accountId: "a", provider: "memory", size: 100 });
    expect(file.key).toMatch(/^media\/[0-9a-f-]{36}$/);
    expect(ticket.fields.key).toBe(file.key);
    expect(accounts.get("a").used).toBe(100);
  });

  it("gives each ticket its own unguessable key", async () => {
    accounts.add("a", { capacity: 1000 });
    const keys = await Promise.all([service.createUploadTicket(request), service.createUploadTicket(request)]);
    expect(keys[0].file.key).not.toBe(keys[1].file.key);
  });

  it("skips accounts that cannot do direct upload and gives their reservation back", async () => {
    accounts.add("plain", { capacity: 1000, priority: 1, provider: noDirect });
    accounts.add("direct", { capacity: 1000, priority: 2 });

    const { file } = await service.createUploadTicket(request);

    expect(file.accountId).toBe("direct");
    expect(accounts.get("plain").used).toBe(0);
    expect(accounts.get("direct").used).toBe(100);
  });

  it("says so (501) when no account supports direct upload, leaking no reservation", async () => {
    accounts.add("plain", { capacity: 1000, provider: noDirect });

    await expect(service.createUploadTicket(request)).rejects.toMatchObject({
      statusCode: StatusCodes.NOT_IMPLEMENTED,
    });
    expect(accounts.get("plain").used).toBe(0);
  });

  it("returns 507 when every account is full", async () => {
    accounts.add("a", { capacity: 50 });
    await expect(service.createUploadTicket(request)).rejects.toBeInstanceOf(StorageFullError);
    expect(accounts.get("a").used).toBe(0);
  });

  it("moves to the next account when the first has no room", async () => {
    accounts.add("small", { capacity: 50, priority: 1 });
    accounts.add("big", { capacity: 1000, priority: 2 });
    expect((await service.createUploadTicket(request)).file.accountId).toBe("big");
  });

  it("releases the reservation if the provider cannot create the ticket", async () => {
    const broken = Object.assign(new MemoryProvider(), {
      createUploadTicket: () => {
        throw new Error("signing failed");
      },
    });
    accounts.add("a", { capacity: 1000, provider: broken });

    await expect(service.createUploadTicket(request)).rejects.toMatchObject({ statusCode: StatusCodes.BAD_GATEWAY });
    expect(accounts.get("a").used).toBe(0);
  });
});

describe("StorageService.inspect and settle", () => {
  it("reports what the provider actually received", async () => {
    const provider = new MemoryProvider();
    accounts.add("a", { capacity: 1000, provider });
    const { file } = await service.createUploadTicket(request);

    expect(await service.inspect(file)).toBeNull(); // nothing uploaded yet

    provider.simulateClientUpload(file.key, Buffer.alloc(70), "image/png");
    expect(await service.inspect(file)).toMatchObject({ size: 70, mimeType: "image/png" });
  });

  it("settle gives back the unused part of the reservation", async () => {
    accounts.add("a", { capacity: 1000 });
    const { file } = await service.createUploadTicket(request); // reserved 100

    await service.settle(file.accountId, 100, 70);
    expect(accounts.get("a").used).toBe(70);
  });

  it("settle never charges extra or double-releases", async () => {
    accounts.add("a", { capacity: 1000 });
    const { file } = await service.createUploadTicket(request);

    await service.settle(file.accountId, 100, 100);
    await service.settle(file.accountId, 100, 150);
    expect(accounts.get("a").used).toBe(100);
  });

  it("inspect fails loudly for an unknown account or a provider without direct upload", async () => {
    await expect(service.inspect({ accountId: "ghost", key: "k" })).rejects.toThrow("no longer exists");
    accounts.add("plain", { capacity: 1000, provider: noDirect });
    await expect(service.inspect({ accountId: "plain", key: "k" })).rejects.toThrow("cannot inspect");
  });
});
