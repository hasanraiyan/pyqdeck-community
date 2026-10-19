import type { Response } from "express";
import { StatusCodes } from "http-status-codes";
import type { PageMeta } from "./pagination.js";

export function sendSuccess(res: Response, data: unknown, status: StatusCodes = StatusCodes.OK) {
  res.status(status).json({ success: true, data });
}

export function sendPaginated(res: Response, items: unknown[], pagination: PageMeta) {
  res.status(StatusCodes.OK).json({ success: true, data: items, pagination });
}

export function sendNoContent(res: Response) {
  res.status(StatusCodes.NO_CONTENT).send();
}

export function sendCursorPage(res: Response, items: unknown[], page: { nextCursor: string | null; hasMore: boolean }) {
  res
    .status(StatusCodes.OK)
    .json({ success: true, data: items, pagination: { nextCursor: page.nextCursor, hasMore: page.hasMore } });
}
