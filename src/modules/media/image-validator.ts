import { fileTypeFromBuffer } from "file-type";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../../core/errors/AppError.js";
import { ALLOWED_IMAGE_TYPES, MAX_FILE_BYTES } from "./media.constants.js";
import type { FileValidator, ValidatedFile } from "./media.types.js";

/** Trusts the file's bytes, not its name or the client-sent Content-Type, both of which are attacker-controlled. */
export class ImageValidator implements FileValidator {
  constructor(
    private readonly allowed: readonly string[] = ALLOWED_IMAGE_TYPES,
    private readonly maxBytes = MAX_FILE_BYTES,
  ) {}

  async validate(buffer: Buffer): Promise<ValidatedFile> {
    if (buffer.length === 0) throw AppError.badRequest("Empty file");
    if (buffer.length > this.maxBytes) {
      throw new AppError(
        StatusCodes.REQUEST_TOO_LONG,
        `Each image must be ${this.maxBytes / (1024 * 1024)} MB or smaller`,
      );
    }
    const detected = await fileTypeFromBuffer(buffer);
    if (!detected || !this.allowed.includes(detected.mime)) {
      throw AppError.badRequest("Only JPEG, PNG and WebP images are allowed");
    }
    return { mimeType: detected.mime };
  }
}
