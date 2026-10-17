import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { ImageValidator } from "../../src/modules/media/image-validator.js";
import { MAX_FILE_BYTES } from "../../src/modules/media/media.constants.js";
import { GIF, JPEG, PDF, PNG, WEBP, pngOfSize } from "../helpers/images.js";

const validator = new ImageValidator();

describe("ImageValidator", () => {
  it.each([
    ["PNG", PNG, "image/png"],
    ["JPEG", JPEG, "image/jpeg"],
    ["WebP", WEBP, "image/webp"],
  ])("accepts %s and reports the detected type", async (_name, buffer, mime) => {
    expect(await validator.validate(buffer)).toEqual({ mimeType: mime });
  });

  it.each([
    ["GIF", GIF],
    ["PDF", PDF],
    ["plain text", Buffer.from("hello world, definitely not an image")],
    ["an HTML file pretending to be an image", Buffer.from("<html><script>alert(1)</script></html>")],
  ])("rejects %s", async (_name, buffer) => {
    await expect(validator.validate(buffer)).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST });
  });

  it("rejects an empty file", async () => {
    await expect(validator.validate(Buffer.alloc(0))).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST });
  });

  it("allows a file exactly at the limit and rejects one byte over with 413", async () => {
    await expect(validator.validate(pngOfSize(MAX_FILE_BYTES))).resolves.toEqual({ mimeType: "image/png" });
    await expect(validator.validate(pngOfSize(MAX_FILE_BYTES + 1))).rejects.toMatchObject({
      statusCode: StatusCodes.REQUEST_TOO_LONG,
    });
  });

  it("is configurable, so another media kind needs no change to the class", async () => {
    const gifsOnly = new ImageValidator(["image/gif"]);
    await expect(gifsOnly.validate(GIF)).resolves.toEqual({ mimeType: "image/gif" });
    await expect(gifsOnly.validate(PNG)).rejects.toBeDefined();
  });
});
