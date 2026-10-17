import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AesGcmCipher, createCipher } from "../../src/modules/storage/crypto/credential-cipher.js";

const cipher = () => new AesGcmCipher(randomBytes(32));

describe("AesGcmCipher", () => {
  it("round-trips text, including unicode and JSON", () => {
    const c = cipher();
    const secret = JSON.stringify({ apiSecret: "päss/wörd+==", note: "日本語" });
    expect(c.decrypt(c.encrypt(secret))).toBe(secret);
  });

  it("never reveals the plaintext in the payload", () => {
    expect(cipher().encrypt("super-secret-value")).not.toContain("super-secret-value");
  });

  it("uses a fresh IV, so the same input encrypts differently each time", () => {
    const c = cipher();
    expect(c.encrypt("same")).not.toBe(c.encrypt("same"));
  });

  it("rejects a tampered payload", () => {
    const c = cipher();
    const [v, iv, tag, data] = c.encrypt("hello").split(".");
    const flipped = Buffer.from(data, "base64url");
    flipped[0] ^= 1;
    expect(() => c.decrypt([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
  });

  it("rejects decryption with the wrong key", () => {
    expect(() => cipher().decrypt(cipher().encrypt("hello"))).toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() => cipher().decrypt("not-a-payload")).toThrow("Unrecognised");
    expect(() => cipher().decrypt("v2.a.b.c")).toThrow("Unrecognised");
  });

  it("requires a 32 byte key", () => {
    expect(() => new AesGcmCipher(randomBytes(16))).toThrow("32 bytes");
  });
});

describe("createCipher", () => {
  it("builds a working cipher from a base64 key", () => {
    const c = createCipher(randomBytes(32).toString("base64"));
    expect(c.decrypt(c.encrypt("x"))).toBe("x");
  });

  it("fails with a clear message when no key is configured", () => {
    expect(() => createCipher(undefined).encrypt("x")).toThrow("STORAGE_ENCRYPTION_KEY");
    expect(() => createCipher(undefined).decrypt("x")).toThrow("STORAGE_ENCRYPTION_KEY");
  });
});
