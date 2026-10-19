import { Types } from "mongoose";
import { z } from "zod";
import { AppError } from "../errors/AppError.js";

export const DEFAULT_CURSOR_LIMIT = 20;
export const MAX_CURSOR_LIMIT = 50;

/** Cursor pagination: inserts during scrolling cause no duplicates or gaps (IR-API-7). */
export const cursorQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CURSOR_LIMIT).default(DEFAULT_CURSOR_LIMIT),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export type Direction = "asc" | "desc";

interface CursorPosition {
  t: Date;
  id: Types.ObjectId;
}

export const encodeCursor = (doc: { createdAt?: Date; _id: Types.ObjectId }): string =>
  Buffer.from(JSON.stringify({ t: doc.createdAt?.toISOString(), id: doc._id.toString() })).toString("base64url");

function decodeCursor(cursor: string): CursorPosition {
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t: string; id: string };
    const t = new Date(raw.t);
    if (Number.isNaN(t.getTime()) || !Types.ObjectId.isValid(raw.id)) throw new Error("bad cursor");
    return { t, id: new Types.ObjectId(raw.id) };
  } catch {
    throw AppError.badRequest("Invalid cursor");
  }
}

/** Mongo condition for "strictly after the cursor" in the given direction, ordered by (createdAt, _id). */
export function cursorCondition(cursor: string | undefined, direction: Direction): Record<string, unknown> {
  if (!cursor) return {};
  const { t, id } = decodeCursor(cursor);
  const op = direction === "desc" ? "$lt" : "$gt";
  return { $or: [{ createdAt: { [op]: t } }, { createdAt: t, _id: { [op]: id } }] };
}

export const cursorSort = (direction: Direction) =>
  direction === "desc" ? ({ createdAt: -1, _id: -1 } as const) : ({ createdAt: 1, _id: 1 } as const);

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Pass the rows fetched with `limit + 1`; the extra row only signals that another page exists. */
export function toCursorPage<T extends { createdAt?: Date; _id: Types.ObjectId }>(
  rows: T[],
  limit: number,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor(last) : null };
}
