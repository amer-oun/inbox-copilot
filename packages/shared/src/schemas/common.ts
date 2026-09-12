import { z } from "zod";

/** Prisma `@default(cuid())` ids. */
export const cuidSchema = z.string().regex(/^c[a-z0-9]{24}$/, "invalid id");

export const emailSchema = z.email().max(320).toLowerCase();

/** IANA zone, e.g. "Africa/Tunis". */
export const timezoneSchema = z.string().min(1).max(64);

/** BCP-47-ish language tag, e.g. "en", "fr-CA". */
export const languageSchema = z.string().min(2).max(16);

/** Cursor pagination shared by every list endpoint. */
export const paginationSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
