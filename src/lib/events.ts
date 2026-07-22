import { EventEmitter } from "events";

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
}

export type DomainEventName = keyof DomainEventPayloads;

class DomainEventBus extends EventEmitter {
  publish<E extends DomainEventName>(event: E, payload: DomainEventPayloads[E]): void {
    this.emit(event, payload);
  }
}

export const domainEvents = new DomainEventBus();
