import { prisma } from "../lib/prisma";
import { paginate, resolveListQuery } from "../lib/pagination";
import type { PaginationQuery } from "../lib/pagination";

// Module 33 Session 4B -- review list for quarantined inbound emails
// (Lock #10: "a missed email can be reviewed from UnmatchedInboundEmail").
// Strictly scoped to the caller's own business_id, same tenant-isolation
// bar as every other list endpoint in this repo -- rows with
// business_id: null (no business could be resolved at all, e.g. an
// invalid-signature-adjacent parse failure or a thread_not_found with no
// matching PO in ANY business) are deliberately NOT visible through this
// endpoint to any regular owner/manager, since showing them would mean
// showing content with no proven tenant ownership to someone whose own
// tenant ownership can't be verified against it either. A future
// super_admin-only global view is a reasonable follow-up, not built this
// session (not asked for, and this repo's RBAC has no precedent yet for a
// business-scoped list secretly including cross-tenant rows).
export async function listUnmatchedInboundEmails(query: PaginationQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["received_at"] as const,
    defaultSort: "received_at" as const,
  });

  const where = { business_id: businessId };
  const [rows, total] = await Promise.all([
    prisma.unmatched_inbound_emails.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.unmatched_inbound_emails.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}
