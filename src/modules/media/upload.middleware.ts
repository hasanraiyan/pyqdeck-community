import type { RequestHandler } from "express";
import { StatusCodes } from "http-status-codes";
import multer from "multer";
import { AppError } from "../../core/errors/AppError.js";
import { MAX_FILE_BYTES, MAX_MEDIA_PER_POST } from "./media.constants.js";

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_MEDIA_PER_POST },
}).array("files", MAX_MEDIA_PER_POST);

/** Parses `multipart/form-data` (field "files") and turns multer's errors into our standard error responses. */
export const uploadImages: RequestHandler = (req, res, next) => {
  parser(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(
          new AppError(
            StatusCodes.REQUEST_TOO_LONG,
            `Each image must be ${MAX_FILE_BYTES / (1024 * 1024)} MB or smaller`,
          ),
        );
      }
      return next(AppError.badRequest(`Send up to ${MAX_MEDIA_PER_POST} images in the "files" field`));
    }
    next(err);
  });
};
