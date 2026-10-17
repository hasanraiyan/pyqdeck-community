import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import { StatusCodes } from "http-status-codes";
import { logger } from "../utils/logger.js";

const REQUEST_ID_HEADER = "x-request-id";
const SAFE_ID = /^[\w-]{8,64}$/;

/** Assigns `req.id` (reusing a sane incoming x-request-id), echoes it in the response, and logs each request via `req.log`. */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const id = typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= StatusCodes.INTERNAL_SERVER_ERROR) return "error";
    if (res.statusCode >= StatusCodes.BAD_REQUEST) return "warn";
    return "info";
  },
  autoLogging: { ignore: (req) => req.url === "/api/health" },
});
