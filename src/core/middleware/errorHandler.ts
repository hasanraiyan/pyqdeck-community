import type { ErrorRequestHandler, RequestHandler } from "express";
import { StatusCodes, getReasonPhrase } from "http-status-codes";
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { AppError } from "../errors/AppError.js";

export const notFound: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status: StatusCodes = StatusCodes.INTERNAL_SERVER_ERROR;
  let message: string | undefined;
  let details: unknown;

  if (err instanceof AppError) {
    ({ statusCode: status, message, details } = err);
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = StatusCodes.BAD_REQUEST;
    message = "Validation failed";
    details = Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message]));
  } else if (err instanceof mongoose.Error.CastError) {
    status = StatusCodes.BAD_REQUEST;
    message = `Invalid ${err.path}`;
  } else if (err?.code === 11000) {
    status = StatusCodes.CONFLICT;
    message = "Duplicate value";
    details = err.keyValue;
  } else if (err?.type === "entity.parse.failed") {
    status = StatusCodes.BAD_REQUEST;
    message = "Malformed JSON body";
  }

  if (status >= StatusCodes.INTERNAL_SERVER_ERROR) req.log.error({ err }, "Unhandled error");

  // Never leak internal messages for 5xx outside development.
  const isServerError = status >= StatusCodes.INTERNAL_SERVER_ERROR;
  const safeMessage =
    isServerError && env.NODE_ENV === "production" ? getReasonPhrase(status) : (message ?? getReasonPhrase(status));

  res.status(status).json({
    success: false,
    message: safeMessage,
    requestId: req.id,
    ...(details !== undefined && { details }),
    ...(env.NODE_ENV === "development" && isServerError && { stack: err?.stack }),
  });
};
