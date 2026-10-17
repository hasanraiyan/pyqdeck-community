/** Smallest valid files per format, so file-type sniffing sees real signatures. */

export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
  Buffer.alloc(32),
]);

export const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WEBPVP8 ", "latin1"),
  Buffer.alloc(32),
]);

export const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(32)]);

export const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.alloc(32)]);

/** A buffer with a valid PNG header padded to `bytes`, to test size limits. */
export const pngOfSize = (bytes: number) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, bytes - PNG.length))]);
