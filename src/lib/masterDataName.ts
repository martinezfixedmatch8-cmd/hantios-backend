// Batch 6 (HNT2-HR-001) -- the TypeScript-side equivalent of the canonical
// database normalization expression used by departments/positions'
// active-only partial unique indexes:
//   lower(btrim(regexp_replace(name, '[[:space:]]+', ' ', 'g')))
// Semantically equivalent for allowed input: trim outer whitespace,
// collapse any run of whitespace (space, tab, or mixed) to one ordinary
// space, then lowercase. This is an early usability check only -- the
// database partial index is the final concurrency guarantee (see
// department.service.ts/position.service.ts's own P2002 handling).
//
// Deliberately NOT applied to tags/expense_categories -- those keep their
// pre-existing exact-match name comparison (Batch 6's own locked decision
// narrows their uniqueness SCOPE from global to active-only, but does not
// add a new normalization policy).
export function normalizeMasterDataName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
