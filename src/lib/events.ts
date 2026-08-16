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
  // HNT-FIN-001 remediation -- a correction against an already-paid expense.
  ExpenseCorrected: { businessId: string; expenseId: string; correctionId: string; reason: string };
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
  // Module 05 (Customer Records). No CustomerRestored -- the locked
  // domain-events list names only Created/Updated/Archived; Restored is an
  // audit-log action only. `phone` is the normalized (E.164) form, not the
  // raw display string -- a future subscriber consuming this
  // programmatically (e.g. a notification) would want the dialable,
  // canonical form.
  CustomerCreated: { businessId: string; customerId: string; customerNumber: string; phone: string; occurredAt: string };
  CustomerUpdated: { businessId: string; customerId: string; customerNumber: string; phone: string; occurredAt: string };
  CustomerArchived: { businessId: string; customerId: string; customerNumber: string; phone: string; occurredAt: string };
  // Module 11 (Purchase Orders) prerequisite. No SupplierRestored -- same
  // Created/Updated/Archived-only asymmetry as Customer Records.
  SupplierCreated: { businessId: string; supplierId: string; name: string; occurredAt: string };
  SupplierUpdated: { businessId: string; supplierId: string; name: string; occurredAt: string };
  SupplierArchived: { businessId: string; supplierId: string; name: string; occurredAt: string };
  // Module 11 (Purchase Orders) core. No PurchaseOrderUpdated event -- the
  // locked spec's audit-action list (5: Created/Sent/Confirmed/Updated/
  // Cancelled) and domain-event list (4: no Updated) intentionally differ in
  // count; PO Updated is audit-log-only, matching that literal asymmetry.
  PurchaseOrderCreated: { businessId: string; purchaseOrderId: string; poNumber: string; supplierId: string; totalExpectedValue: string };
  PurchaseOrderSent: { businessId: string; purchaseOrderId: string; poNumber: string };
  PurchaseOrderConfirmed: { businessId: string; purchaseOrderId: string; poNumber: string };
  PurchaseOrderCancelled: { businessId: string; purchaseOrderId: string; poNumber: string; reason: string };
  // Module 11 Session B (GRN, Warehouse Stock Movements, PO Payments).
  GoodsReceivedNoteCreated: {
    businessId: string;
    grnId: string;
    grnNumber: string;
    purchaseOrderId: string;
    purchaseOrderStatus: string;
  };
  WarehouseStockIn: { businessId: string; warehouseId: string; productId: string; movementNumber: string; quantity: string };
  WarehouseStockOut: { businessId: string; warehouseId: string; productId: string; movementNumber: string; quantity: string };
  PurchaseOrderPaymentRecorded: {
    businessId: string;
    purchaseOrderId: string;
    paymentId: string;
    amount: string;
    matchStatus: string;
    paymentStatus: string;
  };
  // PO Supplier Negotiation Core (Session 1). No dispatch/subscriber this
  // session -- publish only, per the locked spec ("Session 1 only publishes
  // domain events, no dispatch/sending logic").
  PurchaseOrderSecureLinkGenerated: { businessId: string; purchaseOrderId: string; secureLinkId: string };
  // Debounced first-view only, mirrors StockLow's own debounce shape.
  PurchaseOrderViewedBySupplier: { businessId: string; purchaseOrderId: string; occurredAt: string };
  PurchaseOrderPdfDownloaded: { businessId: string; purchaseOrderId: string; occurredAt: string };
  PurchaseOrderNegotiationMessageSent: { businessId: string; purchaseOrderId: string; messageId: string; senderType: string };
  PurchaseOrderNegotiationMessageRead: { businessId: string; purchaseOrderId: string; messageId: string; readBy: string };
  PurchaseOrderNegotiationProposalSubmitted: { businessId: string; purchaseOrderId: string; proposalId: string; revisionNumber: number };
  PurchaseOrderNegotiationAccepted: {
    businessId: string;
    purchaseOrderId: string;
    proposalId: string;
    negotiationRound: number;
  };
  PurchaseOrderNegotiationRejected: { businessId: string; purchaseOrderId: string; proposalId: string };
  PurchaseOrderNegotiationAttachmentUploaded: { businessId: string; purchaseOrderId: string; attachmentId: string };
  PurchaseOrderNegotiationDeadlineSet: { businessId: string; purchaseOrderId: string; respondBy: string | null };
  // Session 2A -- Supplier Payment Instructions, Proforma Invoice, Advance
  // Payments. Publish-only, no dispatch, same standing rule as every event
  // above.
  SupplierPaymentInstructionCreated: { businessId: string; supplierId: string; instructionId: string; isDefault: boolean };
  SupplierPaymentInstructionDefaultChanged: { businessId: string; supplierId: string; instructionId: string };
  PurchaseOrderProformaInvoiceIssued: { businessId: string; purchaseOrderId: string; proformaInvoiceId: string; total: string };
  PurchaseOrderAdvancePaymentRecorded: { businessId: string; purchaseOrderId: string; proformaInvoiceId: string; advancePaymentId: string; amount: string };
  // Session 2B -- confirmed via Phase 0 that these did NOT already exist
  // despite the spec assuming they did (only a match_status field inside
  // PurchaseOrderPaymentRecorded's own payload existed before this
  // session). Added for real, fired from recordPurchaseOrderPayment
  // alongside that existing event, not a replacement for it.
  ThreeWayMatchPassed: { businessId: string; purchaseOrderId: string; paymentId: string; matchVariance: string };
  ThreeWayMatchFailed: { businessId: string; purchaseOrderId: string; paymentId: string; matchVariance: string; overridden: boolean };
  PurchaseOrderCommercialInvoiceIssued: { businessId: string; purchaseOrderId: string; commercialInvoiceId: string; totalAmount: string };
  PurchaseOrderCommercialInvoiceSuperseded: { businessId: string; purchaseOrderId: string; commercialInvoiceId: string; supersedesId: string };
  // Module 11 Session 3 -- Shipments/Tracking/Delivery Milestones/ETA.
  // Publish-only, no dispatch, same standing rule as every event above.
  // PurchaseOrderShipmentEtaChanged is what should eventually notify the
  // owner of delays -- publish only this session, no dispatch.
  PurchaseOrderShipmentCreated: { businessId: string; purchaseOrderId: string; shipmentId: string; shipmentNumber: string };
  PurchaseOrderShipmentStatusChanged: { businessId: string; purchaseOrderId: string; shipmentId: string; fromStatus: string; toStatus: string };
  PurchaseOrderShipmentEtaChanged: { businessId: string; purchaseOrderId: string; shipmentId: string; newExpectedArrivalFrom: string | null; newExpectedArrivalTo: string | null };
  PurchaseOrderShipmentAttachmentUploaded: { businessId: string; purchaseOrderId: string; shipmentId: string; attachmentId: string };
  PurchaseOrderDeliveryMilestoneRecorded: { businessId: string; purchaseOrderId: string; milestoneId: string; milestone: string };
  // Added on second review -- the general PATCH endpoint for logistics-
  // execution fields (carrier/tracking/costs/priority), never core
  // identity/contractual-terms fields.
  PurchaseOrderShipmentUpdated: { businessId: string; purchaseOrderId: string; shipmentId: string; changedFields: string[] };
  // Module 33 Session 4B -- Email Conversation Sync (inbound). Publish-only,
  // no dispatch, same standing rule as every event above.
  PurchaseOrderNegotiationEmailReceived: { businessId: string; purchaseOrderId: string; messageId: string; resendEmailId: string };
  PurchaseOrderNegotiationEmailUnmatched: { businessId: string | null; resendEmailId: string; reason: string };
  // Module 06 (Receipt System). Publish-only, no dispatch, same standing
  // rule as every event above -- published post-commit by each trigger's
  // OWN service function (createSale/refundSale/recordPayment/
  // reversePayment/recordWarehouseMovement/createGoodsReceivedNote/
  // recordPurchaseOrderPayment), never from inside generateReceiptInTransaction
  // itself (which runs pre-commit, inside the caller's own transaction).
  ReceiptGenerated: { businessId: string; receiptId: string; receiptNumber: string; receiptType: string };
  ReceiptDeliveryRequested: { businessId: string; receiptId: string; attemptId: string; channel: string };
  ReceiptDeliverySucceeded: { businessId: string; receiptId: string; attemptId: string; channel: string };
  ReceiptDeliveryFailed: { businessId: string; receiptId: string; attemptId: string; channel: string };
  // Module 12 Session A (Payroll). Publish-only, no dispatch, same standing
  // rule as every event above.
  EmployeeCreated: { businessId: string; employeeId: string; name: string; occurredAt: string };
  EmployeeUpdated: { businessId: string; employeeId: string; name: string; occurredAt: string };
  EmployeeArchived: { businessId: string; employeeId: string; name: string; occurredAt: string };
  EmployeeCompensationCreated: { businessId: string; employeeId: string; compensationId: string; compensationModel: string };
  PayrollRecordCreated: { businessId: string; payrollRecordId: string; employeeId: string; periodYear: number; periodMonth: number };
  PayrollMarkedPaid: { businessId: string; payrollRecordId: string; employeeId: string; amount: string };
  // Module 12 Session B (Attendance & Time Tracking). Publish-only, no
  // dispatch, same standing rule as every event above. AttendanceRecorded
  // fires on every create -- it's born "approved" this session (Q2), so
  // there's no separate AttendanceApproved event yet; held in reserve for
  // when a future self-service flow's own separate approval step exists.
  AttendanceRecorded: { businessId: string; attendanceRecordId: string; employeeId: string; workDate: string; hoursWorked: string; occurredAt: string };
  AttendanceAdjustmentCreated: { businessId: string; attendanceRecordId: string; adjustmentId: string; deltaHours: string; occurredAt: string };
  // Module 12 Session C (Sales Attribution & Commission Engine). Publish-only,
  // no dispatch, same standing rule as every event above.
  SaleAttributionSet: { businessId: string; saleId: string; employeeId: string; occurredAt: string };
  SaleAttributionChanged: { businessId: string; saleId: string; previousEmployeeId: string | null; newEmployeeId: string | null; occurredAt: string };
  CommissionAdjustmentCreated: { businessId: string; commissionAdjustmentId: string; employeeId: string; payrollRecordId: string; deltaAmount: string; occurredAt: string };
  CompensationPolicyCreated: { businessId: string; policyId: string; policyType: string; version: string; occurredAt: string };
  CompensationPolicyAcknowledged: { businessId: string; policyId: string; employeeId: string; occurredAt: string };
  // Module 12 Session D. Publish-only, no dispatch, same standing rule as
  // every event above. Self-service attendance reuses the existing
  // AttendanceRecorded event as-is (still "an attendance record was
  // created," just with status:"recorded" instead of "approved" -- no new
  // event needed). Automatic reallocation reuses the existing
  // CommissionAdjustmentCreated event, published twice (once per side) --
  // it's really just two commission_adjustments rows created
  // automatically instead of one created manually, the same underlying
  // fact Session C's own event already represents.
  PayrollReversalCreated: { businessId: string; payrollReversalId: string; payrollRecordId: string; deltaAmount: string; occurredAt: string };
}

export type DomainEventName = keyof DomainEventPayloads;

class DomainEventBus extends EventEmitter {
  publish<E extends DomainEventName>(event: E, payload: DomainEventPayloads[E]): void {
    this.emit(event, payload);
  }
}

export const domainEvents = new DomainEventBus();
