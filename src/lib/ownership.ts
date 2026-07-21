import { notFound } from "./errors";

type Owned = { business_id: string };

// Narrows to non-null AND same-business in one call. Throws the identical 404
// whether the row doesn't exist or belongs to a different business -- a caller
// can never distinguish the two, by construction (prevents IDOR enumeration).
export function assertOwned<T extends Owned>(row: T | null | undefined, businessId: string, label = "Resource"): T {
  if (!row || row.business_id !== businessId) {
    throw notFound(`${label} not found`);
  }
  return row;
}

// Convenience wrapper: awaits a Prisma fetch and applies assertOwned to the
// result in one call. Still scope the fetch's own WHERE clause with
// business_id where practical -- this is the second line of defense, not a
// replacement for querying with the right WHERE in the first place.
export async function getOwned<T extends Owned>(
  fetch: Promise<T | null | undefined>,
  businessId: string,
  label?: string
): Promise<T> {
  return assertOwned(await fetch, businessId, label);
}
