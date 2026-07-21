import { z } from "zod";

// Shared query shape every module's list-schema composes via .extend(...),
// same pattern auth.schema.ts uses for phoneSchema/countrySchema.
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  sort: z.string().trim().optional(),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  search: z.string().trim().min(1).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface ListConfig<TSortField extends string> {
  sortableFields: readonly TSortField[];
  defaultSort: TSortField;
  searchableFields?: readonly string[]; // snake_case Prisma string columns only
}

export interface ResolvedListQuery {
  skip: number;
  take: number;
  page: number;
  pageSize: number;
  orderBy: Record<string, "asc" | "desc">;
  searchWhere?: { OR: Record<string, { contains: string; mode: "insensitive" }>[] };
}

// Doesn't wrap the actual Prisma findMany/count call -- this repo has no
// ORM-abstraction layer anywhere, each service writes its own query using
// these resolved pieces directly (see staffInvite.service.ts / auth.service.ts).
// Unknown `sort` values fall back to defaultSort rather than 400ing.
export function resolveListQuery<TSortField extends string>(
  query: PaginationQuery,
  config: ListConfig<TSortField>
): ResolvedListQuery {
  const sortField = (config.sortableFields as readonly string[]).includes(query.sort ?? "")
    ? (query.sort as TSortField)
    : config.defaultSort;

  return {
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
    page: query.page,
    pageSize: query.pageSize,
    orderBy: { [sortField]: query.order },
    searchWhere:
      query.search && config.searchableFields && config.searchableFields.length > 0
        ? {
            OR: config.searchableFields.map((field) => ({
              [field]: { contains: query.search as string, mode: "insensitive" as const },
            })),
          }
        : undefined,
  };
}

export interface PaginationEnvelope {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function paginate<T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number
): { data: T[]; pagination: PaginationEnvelope } {
  return { data, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}
