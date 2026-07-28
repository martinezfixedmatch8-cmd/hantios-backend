import { prisma } from "./prisma";
import { domainEvents } from "./events";
import type { DomainEventPayloads } from "./events";
import { getNotificationProvider } from "../notifications/registry";
import { renderTemplate } from "./messageTemplates";
import { writeAuditLog } from "./auditLog";

// The first real production subscriber to domainEvents in this repo -- every
// other event still has zero subscribers, only ephemeral test listeners.
// Deliberately minimal: discover recipients, render, send, audit. Real
// escalation (Purchasing/Procurement) and an in-app Notification Center are
// both explicitly out of scope this session -- see CLAUDE.md.
//
// Fire-and-forget by design (EventEmitter doesn't await async listeners):
// the debounce STATE that triggered this was already written transactionally
// by the caller, so it's never wrong or duplicated -- only this delivery
// step is best-effort. A crash here can silently miss a notification for an
// entire low-stock episode (accepted tradeoff, not hardened this session,
// see CLAUDE.md). Every failure path below is caught, never rethrown -- this
// must never surface as an unhandled rejection or affect the sale/adjustment
// that already committed.

async function handleStockLow(payload: DomainEventPayloads["StockLow"]): Promise<void> {
  const business = await prisma.businesses.findUnique({ where: { id: payload.businessId } });
  // audit_logs.user_id is a required FK to a real users row -- a business
  // with no owner has no FK-valid actor to record this under, so it's
  // skipped rather than crashing. Same defensive check the Reminder
  // Scheduler already uses for the identical reason.
  if (!business || !business.owner_id) return;
  const owner = await prisma.users.findUnique({ where: { id: business.owner_id } });
  if (!owner) return;

  const [branch, product] = await Promise.all([
    prisma.branches.findUnique({ where: { id: payload.branchId } }),
    prisma.products.findUnique({ where: { id: payload.productId } }),
  ]);
  if (!branch || !product) return;

  const systemActor = { userId: owner.id, businessId: payload.businessId, userName: "Stock Alert System", userRole: owner.role };

  const [managers, owners] = await Promise.all([
    prisma.users.findMany({
      where: { branch_id: payload.branchId, role: "manager", phone_verified_at: { not: null }, status: "active" },
    }),
    prisma.users.findMany({
      where: { business_id: payload.businessId, role: "owner", phone_verified_at: { not: null }, status: "active" },
    }),
  ]);
  const recipients = [...managers, ...owners];

  if (recipients.length === 0) {
    await writeAuditLog(prisma, {
      businessId: payload.businessId,
      userId: systemActor.userId,
      userName: systemActor.userName,
      userRole: systemActor.userRole,
      action: "inventory.low_stock_alert_sent",
      entityType: "product",
      entityId: payload.productId,
      reason: `Low stock alert (${payload.severity}) for "${product.name}" at "${branch.name}" -- no recipients matched (no verified manager/owner phone numbers)`,
    });
    return;
  }

  const body = renderTemplate("low_stock_alert", business.language, {
    productName: product.name,
    quantity: payload.currentQuantity,
    minStockLevel: payload.minStockLevel,
    branchName: branch.name,
  });

  // One audit row per recipient, not one summary row -- matching the finer
  // grain Sales/Debts/Expenses already audit at, so a partial delivery
  // failure (e.g. 1 of 3 sends failing) is individually visible.
  for (const recipient of recipients) {
    let status: "sent" | "failed" = "sent";
    let error: string | null = null;
    try {
      await getNotificationProvider().send({ category: "BUSINESS_OPERATIONS", channel: "whatsapp", to: recipient.phone, body });
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : "Unknown notification error";
    }

    await writeAuditLog(prisma, {
      businessId: payload.businessId,
      userId: systemActor.userId,
      userName: systemActor.userName,
      userRole: systemActor.userRole,
      action: "inventory.low_stock_alert_sent",
      entityType: "user",
      entityId: recipient.id,
      reason: `Low stock alert (${payload.severity}) for "${product.name}" at "${branch.name}" ${status} to ${recipient.name} (${recipient.role}) via WhatsApp${error ? `: ${error}` : ""}`,
    });
  }
}

// Event + audit log only -- no WhatsApp send (confirmed decision: recovery
// isn't urgent the way a shortage is). No per-recipient detail either, since
// nothing was sent.
async function handleStockRecovered(payload: DomainEventPayloads["StockRecovered"]): Promise<void> {
  const business = await prisma.businesses.findUnique({ where: { id: payload.businessId } });
  if (!business || !business.owner_id) return;
  const owner = await prisma.users.findUnique({ where: { id: business.owner_id } });
  if (!owner) return;

  const [branch, product] = await Promise.all([
    prisma.branches.findUnique({ where: { id: payload.branchId } }),
    prisma.products.findUnique({ where: { id: payload.productId } }),
  ]);
  if (!branch || !product) return;

  await writeAuditLog(prisma, {
    businessId: payload.businessId,
    userId: owner.id,
    userName: "Stock Alert System",
    userRole: owner.role,
    action: "inventory.stock_recovered",
    entityType: "product",
    entityId: payload.productId,
    reason: `Stock recovered for "${product.name}" at "${branch.name}" -- back to ${payload.currentQuantity} units (minimum: ${payload.minStockLevel})`,
  });
}

let registered = false;

// Idempotent, mirrors reminderScheduler.ts's startReminderScheduler() guard
// exactly -- safe to call more than once (production boot calls it once;
// tests call it explicitly since they never import src/index.ts).
export function startStockAlertSubscriber(): void {
  if (registered) return;
  domainEvents.on("StockLow", (payload) => {
    handleStockLow(payload).catch((err) => {
      console.error("[stockAlertSubscriber] StockLow handler failed:", err);
    });
  });
  domainEvents.on("StockRecovered", (payload) => {
    handleStockRecovered(payload).catch((err) => {
      console.error("[stockAlertSubscriber] StockRecovered handler failed:", err);
    });
  });
  registered = true;
}
