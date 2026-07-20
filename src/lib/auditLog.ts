import type { Prisma, PrismaClient } from "@prisma/client";
import { generateId } from "./ids";

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditLogInput {
  businessId: string;
  userId: string;
  userName: string;
  userRole: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: unknown;
  afterState?: unknown;
  reason: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

export async function writeAuditLog(db: Db, input: AuditLogInput): Promise<void> {
  await db.audit_logs.create({
    data: {
      id: generateId(),
      business_id: input.businessId,
      user_id: input.userId,
      user_name: input.userName,
      user_role: input.userRole,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      before_state: input.beforeState as Prisma.InputJsonValue | undefined,
      after_state: input.afterState as Prisma.InputJsonValue | undefined,
      reason: input.reason,
      ip_address: input.ipAddress,
      user_agent: input.userAgent,
      correlation_id: input.correlationId,
    },
  });
}
