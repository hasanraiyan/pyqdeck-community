import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** Extend this in a feature's list schema to add filters: `paginationQuerySchema.extend({ semester: z.coerce.number().optional() })`. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  /** Comma separated fields, `-` prefix for descending: `-createdAt,name` */
  sort: z
    .string()
    .regex(/^-?[\w.]+(,-?[\w.]+)*$/, "Invalid sort")
    .default("-createdAt"),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface PageMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export function buildPageMeta(total: number, page: number, limit: number): PageMeta {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}

/** `-createdAt,name` -> `-createdAt name` (Mongoose sort string). */
export function toMongoSort(sort: string): string {
  return sort.split(",").join(" ");
}
