import { StatusCodes, getReasonPhrase } from "http-status-codes";

export class AppError extends Error {
  constructor(
    public readonly statusCode: StatusCodes,
    message: string = getReasonPhrase(statusCode),
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(message?: string, details?: unknown) {
    return new AppError(StatusCodes.BAD_REQUEST, message, details);
  }
  static unauthorized(message?: string) {
    return new AppError(StatusCodes.UNAUTHORIZED, message);
  }
  static forbidden(message?: string) {
    return new AppError(StatusCodes.FORBIDDEN, message);
  }
  static notFound(message?: string) {
    return new AppError(StatusCodes.NOT_FOUND, message);
  }
  static conflict(message?: string) {
    return new AppError(StatusCodes.CONFLICT, message);
  }
  static unprocessable(message?: string, details?: unknown) {
    return new AppError(StatusCodes.UNPROCESSABLE_ENTITY, message, details);
  }
  static tooManyRequests(message?: string) {
    return new AppError(StatusCodes.TOO_MANY_REQUESTS, message);
  }
  static internal(message?: string) {
    return new AppError(StatusCodes.INTERNAL_SERVER_ERROR, message);
  }
}
