// Module 06 (Receipt System) -- the shape of receipts.snapshot (Json). This
// is the sole source of truth for a receipt's content once issued (Receipt
// Content Completeness, LOCKED) -- rendering must reconstruct the receipt
// from this alone, never by re-querying mutable Sale/Product/Business/
// Customer records. Every field a business rule marks "must never be
// silently omitted" is required here, not optional.

export interface ReceiptSnapshotLineItem {
  productName: string;
  size: string | null;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
}

export interface ReceiptSnapshotBusiness {
  name: string;
  address: string | null;
  logoUrl: string | null;
}

// Type-specific detail blocks -- exactly one populated per receipt_type,
// mirroring the header table's own sparse-source-FK design one level down.
// Debt Payment Receipt carries enough here for full-vs-partial to be
// structurally self-evident (never rendered identically) without needing a
// separate schema type, per the confirmed Phase 0 decision.
export interface ReceiptDebtPaymentContext {
  amountOriginal: string;
  amountPaidTotal: string;
  remainingBalance: string;
  isFullPayment: boolean;
  isReversal: boolean;
}

export interface ReceiptWarehouseStockOutContext {
  warehouseName: string;
  destinationBranchName: string | null;
  movementNumber: string;
}

export interface ReceiptSupplierGoodsReceivedContext {
  supplierName: string;
  poNumber: string;
  grnNumber: string;
}

export interface ReceiptPoSettlementContext {
  supplierName: string;
  poNumber: string;
  matchStatus: string;
}

export interface ReceiptRefundContext {
  originalReceiptNumber: string;
}

// Module 12 Session A -- Payroll Receipt (7th type). Period is spelled out
// as a display string (e.g. "August 2026"), not raw year/month ints,
// since the snapshot exists specifically so rendering never needs to
// re-derive anything from mutable/live records.
export interface ReceiptPayrollContext {
  employeeName: string;
  position: string | null;
  periodLabel: string;
  compensationModel: string;
}

export interface ReceiptSnapshot {
  business: ReceiptSnapshotBusiness;
  items: ReceiptSnapshotLineItem[];
  paymentMethod: string | null;
  debtPayment?: ReceiptDebtPaymentContext;
  warehouseStockOut?: ReceiptWarehouseStockOutContext;
  supplierGoodsReceived?: ReceiptSupplierGoodsReceivedContext;
  poSettlement?: ReceiptPoSettlementContext;
  refund?: ReceiptRefundContext;
  payroll?: ReceiptPayrollContext;
}
