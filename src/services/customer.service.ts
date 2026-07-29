import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { writeAuditLog } from "../lib/auditLog";
import { resolveListQuery, paginate } from "../lib/pagination";
import { badRequest, conflict } from "../lib/errors";
import { claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { domainEvents } from "../lib/events";
import { normalizePhone, tryNormalizePhone } from "../lib/phoneNormalization";
import { getNextCustomerNumber } from "../lib/customerNumber";
import type { CreateCustomerInput, UpdateCustomerInput, ListCustomersQuery, ArchiveCustomerInput, RestoreCustomerInput, CustomerTimelineQuery } from "../validation/customer.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_CUSTOMER_ENDPOINT = "POST /customers";
export const updateCustomerEndpoint = (id: string): string => `PATCH /customers/${id}`;
export const archiveCustomerEndpoint = (id: string): string => `POST /customers/${id}/archive`;
export const restoreCustomerEndpoint = (id: string): string => `POST /customers/${id}/restore`;

// `timeout` alone (matching SALE_TRANSACTION_OPTIONS/DEBT_TRANSACTION_OPTIONS's
// existing precedent) is not enough here -- getNextCustomerNumber's atomic
// per-business counter row is the same kind of deliberate serialization
// point receipt_counters/expense_counters already have, but a real 18-way
// concurrent stress test (well beyond the 5-way that originally motivated
// those two) surfaced a DIFFERENT Prisma error class: P2028 "Unable to start
// a transaction in the given time" -- Prisma's `maxWait` (the time allowed
// to even BEGIN a transaction, default 2000ms) being exceeded while several
// transactions ahead of it are still serializing on the same counter row,
// not `timeout` (the time a transaction is allowed to run once started).
// Raising both closes this under the concurrency actually tested.
const CUSTOMER_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

// ---------------------------------------------------------------------------
// Shared find-or-create -- this repo's first cross-service import
// (debt.service.ts and sale.service.ts both call this). Kept strictly
// one-directional: this file never imports either of them back.
// ---------------------------------------------------------------------------

// Active-only lookup: an archived customer holding this phone is never
// reused/reactivated here (archived customers can't be selected for new
// transactions) -- a brand-new active customer is created instead, which is
// legal precisely because uniqueness (the partial unique index) is scoped to
// active-only. Verified by a dedicated test in tests/customer.test.ts.
export async function findOrCreateCustomer(
  tx: Prisma.TransactionClient,
  params: { businessId: string; phoneRaw: string; name: string | undefined; defaultCountry: string }
): Promise<Prisma.customersGetPayload<Record<string, never>>> {
  const { normalized, original } = normalizePhone(params.phoneRaw, params.defaultCountry);

  const existing = await tx.customers.findFirst({
    where: { business_id: params.businessId, phone_normalized: normalized, status: "active" },
  });
  if (existing) return existing;

  const customerNumber = await getNextCustomerNumber(tx, params.businessId);
  const id = generateId();

  // Atomic insert-or-skip via raw SQL -- deliberately NOT a try/catch around
  // tx.customers.create() catching P2002. A real concurrency test caught a
  // genuine bug in that shape (the same shape this repo's original Session 4
  // find-or-create used, in debt.service.ts, before this session): once one
  // statement in a Postgres transaction fails, the ENTIRE transaction is
  // poisoned ("current transaction is aborted") until an explicit ROLLBACK --
  // Prisma's JS try/catch does not issue a SAVEPOINT around the failing
  // statement, so any further query in the same tx (including the recovery
  // fetch for the race's winner) fails too, surfacing as an unhandled 500.
  // `ON CONFLICT ... DO NOTHING` never throws on a lost race in the first
  // place, so there is nothing to recover from mid-transaction. The partial
  // unique index (business_id, phone_normalized) WHERE status = 'active' is
  // still the real guard; this just makes losing the race a normal,
  // query-able outcome instead of a thrown error.
  // updated_at has no DB-level default -- Prisma's generated create()/update()
  // populate @updatedAt fields at the application layer, which raw SQL
  // bypasses entirely, so it must be set explicitly here (caught by this
  // same concurrency test, immediately after the ON CONFLICT fix above).
  const inserted = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO customers (id, business_id, customer_number, phone_original, phone_normalized, name, status, created_at, updated_at)
    VALUES (${id}, ${params.businessId}, ${customerNumber}, ${original}, ${normalized}, ${params.name ?? null}, 'active', now(), now())
    ON CONFLICT (business_id, phone_normalized) WHERE status = 'active' DO NOTHING
    RETURNING id
  `);

  if (inserted.length > 0) {
    return tx.customers.findUniqueOrThrow({ where: { id: inserted[0].id } });
  }

  // Lost the race -- another concurrent call already created the active
  // customer for this phone. The customer number just allocated is skipped,
  // not reused (same accepted gap-not-reuse behavior expense_counters/
  // receipt_counters already have).
  return tx.customers.findFirstOrThrow({
    where: { business_id: params.businessId, phone_normalized: normalized, status: "active" },
  });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createCustomer(input: CreateCustomerInput, actor: Actor, idempotencyKey: string) {
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
  const { normalized, original } = normalizePhone(input.phone, business.country);

  const customer = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_CUSTOMER_ENDPOINT);

    // An explicit manual add must never silently merge into an existing
    // customer the way findOrCreateCustomer does -- a real duplicate is a
    // clean conflict, not a quiet reuse. The partial unique index is still
    // the real race guard underneath (caught below).
    const existing = await tx.customers.findFirst({
      where: { business_id: actor.businessId, phone_normalized: normalized, status: "active" },
    });
    if (existing) {
      throw conflict("An active customer with this phone number already exists");
    }

    const customerNumber = await getNextCustomerNumber(tx, actor.businessId);
    let created;
    try {
      created = await tx.customers.create({
        data: {
          id: generateId(),
          business_id: actor.businessId,
          customer_number: customerNumber,
          phone_original: original,
          phone_normalized: normalized,
          name: input.name,
          email: input.email,
          notes: input.notes,
          status: "active",
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw conflict("An active customer with this phone number already exists");
      }
      throw err;
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "customer.created",
      entityType: "customer",
      entityId: created.id,
      reason: `Customer ${created.customer_number} added manually`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_CUSTOMER_ENDPOINT, 201, responseBody);

    return created;
  }, CUSTOMER_TRANSACTION_OPTIONS);

  domainEvents.publish("CustomerCreated", {
    businessId: actor.businessId,
    customerId: customer.id,
    customerNumber: customer.customer_number,
    phone: customer.phone_normalized,
    occurredAt: customer.created_at.toISOString(),
  });

  return customer;
}

// "Looks phone-like" is a cheap heuristic (not full relevance scoring, per
// the locked requirement) -- mostly digits/phone punctuation, or something
// tryNormalizePhone can actually parse.
function looksPhoneLike(term: string): boolean {
  return /^[\d+\-\s().]{3,}$/.test(term);
}

export async function listCustomers(query: ListCustomersQuery, businessId: string) {
  const business = await prisma.businesses.findUniqueOrThrow({ where: { id: businessId } });
  const resolved = resolveListQuery(query, {
    sortableFields: ["name", "created_at", "last_activity_at", "customer_number"] as const,
    defaultSort: "created_at" as const,
  });

  const statusFilter = query.status;
  const searchTerm = query.search;
  const normalizedSearch = searchTerm ? tryNormalizePhone(searchTerm, business.country) : null;
  const isPhoneLikeSearch = !!searchTerm && (looksPhoneLike(searchTerm) || normalizedSearch !== null);

  if (searchTerm && isPhoneLikeSearch) {
    // Search ranking (simple, not full relevance scoring): when the search
    // term looks phone-like, phone matches are ranked before name/email/
    // customer-number matches via a boolean CASE expression -- needs raw SQL
    // since Prisma's query builder can't express a computed ORDER BY rank.
    const like = `%${searchTerm}%`;
    const sortColumn = resolved.orderBy && Object.keys(resolved.orderBy)[0] ? Object.keys(resolved.orderBy)[0] : "created_at";
    const sortDir = resolved.orderBy?.[sortColumn] === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const allowedSortColumns = ["name", "created_at", "last_activity_at", "customer_number"];
    const safeSortColumn = allowedSortColumns.includes(sortColumn) ? sortColumn : "created_at";

    const statusClause = statusFilter ? Prisma.sql`AND status = ${statusFilter}::"RecordStatus"` : Prisma.empty;
    const phoneClause = normalizedSearch ? Prisma.sql`OR phone_normalized = ${normalizedSearch.normalized}` : Prisma.empty;

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT id, business_id, customer_number, phone_original, phone_normalized, name, email, notes,
             total_spent, purchase_count, total_debts, total_payments,
             last_purchase_at, last_debt_at, last_payment_at, last_activity_at,
             debt_balance, status::text AS status, archived_reason, version, created_at, updated_at,
             (CASE WHEN phone_normalized ILIKE ${like} OR phone_original ILIKE ${like} ${phoneClause} THEN 0 ELSE 1 END) AS match_rank
      FROM customers
      WHERE business_id = ${businessId}
        ${statusClause}
        AND (name ILIKE ${like} OR email ILIKE ${like} OR customer_number ILIKE ${like}
             OR phone_original ILIKE ${like} OR phone_normalized ILIKE ${like} ${phoneClause})
      ORDER BY match_rank ASC, ${Prisma.raw(safeSortColumn)} ${sortDir}
      LIMIT ${resolved.take} OFFSET ${resolved.skip}
    `);

    const countRows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count FROM customers
      WHERE business_id = ${businessId}
        ${statusClause}
        AND (name ILIKE ${like} OR email ILIKE ${like} OR customer_number ILIKE ${like}
             OR phone_original ILIKE ${like} OR phone_normalized ILIKE ${like} ${phoneClause})
    `);

    // match_rank only drove ORDER BY above -- strip it before returning.
    const data = rows.map((row) => {
      const { match_rank, ...rest } = row;
      void match_rank;
      return rest;
    });
    return paginate(data, Number(countRows[0]?.count ?? 0), query.page, query.pageSize);
  }

  const searchOr: Prisma.customersWhereInput[] = [];
  if (searchTerm) {
    searchOr.push(
      { name: { contains: searchTerm, mode: "insensitive" } },
      { email: { contains: searchTerm, mode: "insensitive" } },
      { customer_number: { contains: searchTerm, mode: "insensitive" } },
      { phone_original: { contains: searchTerm, mode: "insensitive" } }
    );
  }

  const where: Prisma.customersWhereInput = {
    business_id: businessId,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(searchOr.length > 0 ? { OR: searchOr } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.customers.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.customers.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

export async function getCustomer(id: string, businessId: string) {
  return getOwned(prisma.customers.findUnique({ where: { id } }), businessId, "Customer");
}

export async function updateCustomer(id: string, input: UpdateCustomerInput, actor: Actor) {
  const customer = await getOwned(prisma.customers.findUnique({ where: { id } }), actor.businessId, "Customer");

  let normalizedPhone: { normalized: string; original: string } | null = null;
  if (input.phone !== undefined && input.phone !== null) {
    const business = await prisma.businesses.findUniqueOrThrow({ where: { id: actor.businessId } });
    normalizedPhone = normalizePhone(input.phone, business.country);
    if (normalizedPhone.normalized !== customer.phone_normalized) {
      // Re-validate active-only uniqueness the same way restore does --
      // the partial unique index is still the real guard against a
      // concurrent race, this is the clean-error pre-check.
      const conflicting = await prisma.customers.findFirst({
        where: { business_id: actor.businessId, phone_normalized: normalizedPhone.normalized, status: "active", id: { not: id } },
      });
      if (conflicting) {
        throw conflict("Another active customer already uses this phone number");
      }
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    let updateResult;
    try {
      updateResult = await tx.customers.updateMany({
        where: { id, business_id: actor.businessId, version: input.version },
        data: {
          ...(normalizedPhone ? { phone_original: normalizedPhone.original, phone_normalized: normalizedPhone.normalized } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          version: { increment: 1 },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw conflict("Another active customer already uses this phone number");
      }
      throw err;
    }
    if (updateResult.count === 0) {
      throw conflict("Customer was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "customer.updated",
      entityType: "customer",
      entityId: id,
      reason: `Customer ${customer.customer_number} updated`,
    });

    return tx.customers.findUniqueOrThrow({ where: { id } });
  });

  domainEvents.publish("CustomerUpdated", {
    businessId: actor.businessId,
    customerId: updated.id,
    customerNumber: updated.customer_number,
    phone: updated.phone_normalized,
    occurredAt: updated.updated_at.toISOString(),
  });

  return updated;
}

// Archiving with an outstanding debt_balance is allowed unconditionally --
// matches how Branches/PaymentMethods/Expenses already archive without
// checking for related live data. Archiving only hides the customer from
// NEW-transaction selection; their existing debts stay fully visible and
// collectible via the Debts module directly.
export async function archiveCustomer(id: string, input: ArchiveCustomerInput, actor: Actor, idempotencyKey: string) {
  const customer = await getOwned(prisma.customers.findUnique({ where: { id } }), actor.businessId, "Customer");
  if (customer.status === "archived") throw badRequest("Customer is already archived");

  const result = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveCustomerEndpoint(id));

    const updateResult = await tx.customers.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "active" },
      data: { status: "archived", archived_reason: input.reason, version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      throw conflict("Customer was modified concurrently, please retry with the latest version");
    }

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "customer.archived",
      entityType: "customer",
      entityId: id,
      reason: input.reason,
    });

    const updated = await tx.customers.findUniqueOrThrow({ where: { id } });
    const responseBody = JSON.parse(JSON.stringify({ data: updated })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, archiveCustomerEndpoint(id), 200, responseBody);
    return updated;
  }, CUSTOMER_TRANSACTION_OPTIONS);

  domainEvents.publish("CustomerArchived", {
    businessId: actor.businessId,
    customerId: result.id,
    customerNumber: result.customer_number,
    phone: result.phone_normalized,
    occurredAt: new Date().toISOString(),
  });

  return result;
}

// No Idempotency-Key (per the locked endpoint list) -- safe without one
// anyway, since it's version-guarded and the partial unique index is the
// real guard against a concurrent duplicate-active-phone race.
export async function restoreCustomer(id: string, input: RestoreCustomerInput, actor: Actor) {
  const customer = await getOwned(prisma.customers.findUnique({ where: { id } }), actor.businessId, "Customer");
  if (customer.status === "active") throw badRequest("Customer is not archived");

  // Pre-check for a clean error message -- the partial unique index (caught
  // below via P2002) is the real guard against a concurrent race between two
  // restores, or a restore racing a create, at the same phone.
  const conflicting = await prisma.customers.findFirst({
    where: { business_id: actor.businessId, phone_normalized: customer.phone_normalized, status: "active", id: { not: id } },
  });
  if (conflicting) {
    throw conflict(`Cannot restore: another active customer (${conflicting.customer_number}) already uses this phone number`);
  }

  let updateResult;
  try {
    updateResult = await prisma.customers.updateMany({
      where: { id, business_id: actor.businessId, version: input.version, status: "archived" },
      data: { status: "active", archived_reason: null, version: { increment: 1 } },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw conflict("Cannot restore: another active customer already uses this phone number");
    }
    throw err;
  }
  if (updateResult.count === 0) {
    throw conflict("Customer was modified concurrently, please retry with the latest version");
  }

  const updated = await prisma.customers.findUniqueOrThrow({ where: { id } });

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "customer.restored",
    entityType: "customer",
    entityId: id,
    reason: `Customer ${updated.customer_number} restored`,
  });

  // No CustomerRestored domain event -- the locked domain-events list names
  // only Created/Updated/Archived.

  return updated;
}

// ---------------------------------------------------------------------------
// Activity Timeline -- the one cursor-paginated exception to {data, pagination}
// ---------------------------------------------------------------------------

interface TimelineCursor {
  occurredAt: string;
  createdAt: string;
  entityId: string;
}

function encodeTimelineCursor(c: TimelineCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeTimelineCursor(raw: string): TimelineCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<TimelineCursor>;
    if (typeof parsed.occurredAt !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.entityId !== "string") {
      throw new Error("shape");
    }
    return parsed as TimelineCursor;
  } catch {
    throw badRequest("Invalid or corrupted cursor");
  }
}

interface TimelineRow {
  type: string;
  occurred_at: Date;
  created_at: Date;
  entity_id: string;
  reference_number: string;
  amount: Prisma.Decimal;
  summary: string;
}

export async function getCustomerTimeline(id: string, businessId: string, query: CustomerTimelineQuery) {
  await getOwned(prisma.customers.findUnique({ where: { id } }), businessId, "Customer");

  const cursor = query.cursor ? decodeTimelineCursor(query.cursor) : null;
  const cursorClause = cursor
    ? Prisma.sql`AND (occurred_at, created_at, entity_id) < (${new Date(cursor.occurredAt)}, ${new Date(cursor.createdAt)}, ${cursor.entityId})`
    : Prisma.empty;

  // Standardized shape (locked): type/timestamp/referenceNumber/amount/summary
  // regardless of source table. `type` values are lowercase, matching this
  // schema's 100%-consistent snake/lowercase enum-string convention (the
  // spec's own SALE/DEBT/PAYMENT notation is translated, not followed
  // literally -- same treatment Low Stock Alert's severity values got).
  // debts.created_at (never date_taken, a back-datable business date, not a
  // true occurrence timestamp) and debt_payments.created_at are the real
  // occurrence timestamps; debt_payments has no direct customer_id, joined
  // through debts.customer_id.
  const rows = await prisma.$queryRaw<TimelineRow[]>(Prisma.sql`
    WITH timeline AS (
      SELECT 'sale'::text AS type, s.timestamp AS occurred_at, s.timestamp AS created_at, s.id AS entity_id,
             COALESCE(s.receipt_id, s.id) AS reference_number, s.total AS amount,
             ('Sale ' || COALESCE(s.receipt_id, s.id)) AS summary
      FROM sales s
      WHERE s.business_id = ${businessId} AND s.customer_id = ${id}

      UNION ALL

      SELECT 'debt'::text, d.created_at, d.created_at, d.id,
             d.id, d.amount_original,
             ('Debt of ' || d.amount_original::text || ' recorded')
      FROM debts d
      WHERE d.business_id = ${businessId} AND d.customer_id = ${id}

      UNION ALL

      SELECT 'payment'::text, dp.created_at, dp.created_at, dp.id,
             dp.id, dp.amount,
             (CASE WHEN dp.amount < 0 THEN 'Payment reversal of ' ELSE 'Payment of ' END || ABS(dp.amount)::text)
      FROM debt_payments dp
      JOIN debts d2 ON d2.id = dp.debt_id
      WHERE dp.business_id = ${businessId} AND d2.customer_id = ${id}
    )
    SELECT * FROM timeline
    WHERE true ${cursorClause}
    ORDER BY occurred_at DESC, created_at DESC, entity_id DESC
    LIMIT ${query.limit + 1}
  `);

  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeTimelineCursor({ occurredAt: last.occurred_at.toISOString(), createdAt: last.created_at.toISOString(), entityId: last.entity_id })
      : null;

  const data = page.map((row) => ({
    type: row.type,
    timestamp: row.occurred_at,
    referenceNumber: row.reference_number,
    amount: row.amount,
    summary: row.summary,
  }));

  return { data, nextCursor };
}
