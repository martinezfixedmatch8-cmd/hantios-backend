import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getOwned } from "../lib/ownership";
import { forbidden } from "../lib/errors";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { getReplayedResponse, claimIdempotencyKey, completeIdempotencyKey } from "../lib/idempotency";
import { resolveListQuery, paginate } from "../lib/pagination";
import type {
  CreateCompensationPolicyInput,
  ListCompensationPoliciesQuery,
  AcknowledgeCompensationPolicyInput,
} from "../validation/compensationPolicy.schema";

interface Actor {
  userId: string;
  businessId: string;
  userName: string;
  userRole: string;
}

export const CREATE_COMPENSATION_POLICY_ENDPOINT = "POST /compensation-policies";

// A correction is always a NEW version (supersede-not-edit, same
// immutability principle as po_commercial_invoices) -- the previous
// active version of the SAME policy_type flips to superseded in the same
// transaction; its own historical acknowledgements stay exactly as they
// were, never retroactively repointed at the new version.
export async function createCompensationPolicy(input: CreateCompensationPolicyInput, actor: Actor, idempotencyKey: string) {
  const replayed = await getReplayedResponse(actor.businessId, idempotencyKey, CREATE_COMPENSATION_POLICY_ENDPOINT);
  if (replayed) {
    return (replayed.body as { data: Awaited<ReturnType<typeof prisma.compensation_policies.create>> }).data;
  }

  const policy = await prisma.$transaction(async (tx) => {
    await claimIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_COMPENSATION_POLICY_ENDPOINT);

    await tx.compensation_policies.updateMany({
      where: { business_id: actor.businessId, policy_type: input.policyType, status: "active" },
      data: { status: "superseded" },
    });

    const created = await tx.compensation_policies.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        policy_type: input.policyType,
        version: input.version,
        title: input.title,
        content: input.content,
        effective_from: input.effectiveFrom,
        status: "active",
        created_by: actor.userId,
      },
    });

    await writeAuditLog(tx, {
      businessId: actor.businessId,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      action: "compensation_policy.created",
      entityType: "compensation_policy",
      entityId: created.id,
      reason: `${input.policyType} policy v${input.version} ("${input.title}") published, effective ${input.effectiveFrom.toISOString().slice(0, 10)}`,
    });

    const responseBody = JSON.parse(JSON.stringify({ data: created })) as unknown;
    await completeIdempotencyKey(tx, actor.businessId, idempotencyKey, CREATE_COMPENSATION_POLICY_ENDPOINT, 201, responseBody);

    return created;
  });

  domainEvents.publish("CompensationPolicyCreated", {
    businessId: actor.businessId,
    policyId: policy.id,
    policyType: policy.policy_type,
    version: policy.version,
    occurredAt: policy.created_at.toISOString(),
  });

  return policy;
}

export async function listCompensationPolicies(query: ListCompensationPoliciesQuery, businessId: string) {
  const resolved = resolveListQuery(query, {
    sortableFields: ["effective_from", "created_at"] as const,
    defaultSort: "effective_from" as const,
    searchableFields: ["title"],
  });

  const where = {
    business_id: businessId,
    ...(query.policyType ? { policy_type: query.policyType } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(resolved.searchWhere ?? {}),
  };

  const [rows, total] = await Promise.all([
    prisma.compensation_policies.findMany({ where, orderBy: resolved.orderBy, skip: resolved.skip, take: resolved.take }),
    prisma.compensation_policies.count({ where }),
  ]);

  return paginate(rows, total, query.page, query.pageSize);
}

export async function getCompensationPolicy(id: string, businessId: string) {
  return getOwned(prisma.compensation_policies.findUnique({ where: { id } }), businessId, "Compensation policy");
}

// Confirmed inferred RBAC design (flagged, not pre-locked at this
// granularity): owner/manager can record an acknowledgement on ANY
// employee's behalf (most employees have no login, same reasoning
// Attendance's own recording design already established); anyone else can
// ONLY acknowledge for the employee record their own account is linked to
// (employees.user_id) -- since Position/RBAC role tells us nothing about
// which employee record (if any) a given logged-in user actually is.
// Re-acknowledging the SAME policy is treated as an idempotent no-op (the
// @@unique([employee_id, policy_id]) P2002 returns the existing row rather
// than erroring) -- acknowledging twice isn't a data-integrity risk the
// way a duplicate payment would be.
export async function acknowledgeCompensationPolicy(
  policyId: string,
  input: AcknowledgeCompensationPolicyInput,
  actor: Actor
) {
  const policy = await getOwned(prisma.compensation_policies.findUnique({ where: { id: policyId } }), actor.businessId, "Compensation policy");
  const employee = await getOwned(prisma.employees.findUnique({ where: { id: input.employeeId } }), actor.businessId, "Employee");

  const isElevated = actor.userRole === "owner" || actor.userRole === "manager";
  const isSelf = employee.user_id === actor.userId;
  if (!isElevated && !isSelf) {
    throw forbidden("You can only acknowledge a compensation policy on your own behalf, or as owner/manager on an employee's behalf");
  }

  let acknowledgement;
  try {
    acknowledgement = await prisma.compensation_policy_acknowledgements.create({
      data: {
        id: generateId(),
        business_id: actor.businessId,
        employee_id: input.employeeId,
        policy_id: policyId,
        recorded_by: actor.userId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      acknowledgement = await prisma.compensation_policy_acknowledgements.findUniqueOrThrow({
        where: { employee_id_policy_id: { employee_id: input.employeeId, policy_id: policyId } },
      });
      return acknowledgement;
    }
    throw err;
  }

  await writeAuditLog(prisma, {
    businessId: actor.businessId,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    action: "compensation_policy.acknowledged",
    entityType: "compensation_policy",
    entityId: policyId,
    reason: `"${employee.name}" acknowledged ${policy.policy_type} policy v${policy.version}`,
  });

  domainEvents.publish("CompensationPolicyAcknowledged", {
    businessId: actor.businessId,
    policyId,
    employeeId: input.employeeId,
    occurredAt: acknowledgement.accepted_at.toISOString(),
  });

  return acknowledgement;
}
