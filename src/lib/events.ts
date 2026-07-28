import { EventEmitter } from "events";
import type { StockSeverity } from "./stockAlerts";

// Real, minimal in-process domain-event publisher (Session 3B). Sales code
// must never call Notification/Analytics/CRM/Accounting directly -- those
// modules subscribe independently once they exist. Nothing subscribes yet
// (none of those modules are built in this repo), so today this only proves
// the publish side actually fires; the loose coupling is the point, not the
// subscriber count.
//
// Always publish AFTER the triggering transaction has committed, never from
// inside it -- a listener should never react to data that might still roll
// back.
export interface DomainEventPayloads {
  SaleCreated: { saleId: string; businessId: string; branchId: string; receiptId: string | null; total: string };
  SaleVoided: { saleId: string; businessId: string; reason: string };
  RefundCreated: { saleId: string; refundSaleId: string; businessId: string; total: string; reason: string };
  DebtCreated: { debtId: string; businessId: string; customerId: string; amountOriginal: string };
  // Fires per payment action (mirrors RefundCreated's "fires per action" shape,
  // not a status-transition event) -- a reversal also publishes this with a
  // negative amount, not a separate event name.
  DebtPaymentReceived: { debtId: string; businessId: string; paymentId: string; amount: string; amountRemaining: string };
  DebtDisputed: { debtId: string; businessId: string; reason: string };
  DebtWrittenOff: { debtId: string; businessId: string; reason: string };
  InterestApplied: { debtId: string; businessId: string; transactionId: string; amount: string; amountRemaining: string };
  ExpenseCreated: { expenseId: string; businessId: string; branchId: string | null; categoryId: string; amount: string };
  ExpenseUpdated: { expenseId: string; businessId: string };
  ExpenseArchived: { expenseId: string; businessId: string; reason: string };
  ExpenseApproved: { expenseId: string; businessId: string; approvedBy: string };
  ExpenseRejected: { expenseId: string; businessId: string; rejectedBy: string; reason: string };
  ExpensePaid: { expenseId: string; businessId: string; paidBy: string };
  // Module 02 (Inventory) -- the first domain events in this repo with a
  // real production subscriber (src/lib/stockAlertSubscriber.ts); every
  // other event above still has zero subscribers, only ephemeral test
  // listeners. Same rich payload shape for both, per the locked requirement
  // -- StockRecovered's severity is always null (no longer low, so there's
  // nothing to classify), kept as a real field rather than omitted so a
  // future Notification Center subscriber can build per-user records from
  // either event without a redesign.
  StockLow: {
    businessId: string;
    branchId: string;
    productId: string;
    currentQuantity: string;
    minStockLevel: string;
    severity: StockSeverity;
    occurredAt: string;
  };
  StockRecovered: {
    businessId: string;
    branchId: string;
    productId: string;
    currentQuantity: string;
    minStockLevel: string;
    severity: null;
    occurredAt: string;
  };
}

export type DomainEventName = keyof DomainEventPayloads;

class DomainEventBus extends EventEmitter {
  publish<E extends DomainEventName>(event: E, payload: DomainEventPayloads[E]): void {
    this.emit(event, payload);
  }
}

export const domainEvents = new DomainEventBus();
