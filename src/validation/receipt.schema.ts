import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

const RECEIPT_TYPE_VALUES = ["sale", "refund", "debt_payment", "warehouse_stock_out", "supplier_goods_received", "po_settlement"] as const;
const RECEIPT_STATUS_VALUES = ["issued", "voided", "refunded", "partially_refunded"] as const;

export const listReceiptsQuerySchema = paginationQuerySchema.extend({
  type: z.enum(RECEIPT_TYPE_VALUES).optional(),
  status: z.enum(RECEIPT_STATUS_VALUES).optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
});
export type ListReceiptsQueryInput = z.infer<typeof listReceiptsQuerySchema>;

export const requestReceiptDeliverySchema = z.object({
  channel: z.enum(["whatsapp", "pos_print"]),
});
export type RequestReceiptDeliveryInput = z.infer<typeof requestReceiptDeliverySchema>;

// HNT2-RECEIPT-001 -- page/pageSize only, deliberately narrower than the
// generic paginationQuerySchema: attempt order is always attempt_number
// ascending (never client-configurable), and there's no free-text field on
// a delivery attempt worth searching, so sort/order/search are omitted
// rather than exposed-but-unused.
export const listDeliveryAttemptsQuerySchema = paginationQuerySchema.pick({ page: true, pageSize: true });
export type ListDeliveryAttemptsQueryInput = z.infer<typeof listDeliveryAttemptsQuerySchema>;
