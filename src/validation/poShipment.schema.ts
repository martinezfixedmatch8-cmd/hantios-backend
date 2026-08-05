import { z } from "zod";
import { decimalField } from "./common.schema";
import { paginationQuerySchema } from "../lib/pagination";

const SHIPMENT_METHODS = ["air", "sea", "courier"] as const;
const TRACKING_TYPES = ["bill_of_lading", "air_waybill", "container_number", "courier_tracking"] as const;
const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"] as const;
const COST_RESPONSIBILITIES = ["buyer", "supplier", "shared"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const SHIPMENT_STATUSES = ["pending", "dispatched", "in_transit", "customs", "arrived", "delivered", "delayed", "cancelled"] as const;
const CANCELLATION_REASONS = ["supplier_issue", "port_closure", "customer_cancelled", "inventory_issue", "other"] as const;
const ETA_REASON_CATEGORIES = ["weather", "port_congestion", "customs", "carrier_delay", "supplier_delay", "other"] as const;

const shipmentItemSchema = z.object({
  poItemId: z.string().uuid(),
  quantityShipped: decimalField(z.coerce.number().positive()),
});

function rejectDuplicatePoItems(items: { poItemId: string }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.poItemId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `PO item ${item.poItemId} appears more than once in this shipment` });
      return;
    }
    seen.add(item.poItemId);
  }
}

function validateArrivalWindow(input: { expectedArrivalFrom?: Date; expectedArrivalTo?: Date }, ctx: z.RefinementCtx) {
  if (input.expectedArrivalFrom && input.expectedArrivalTo && input.expectedArrivalFrom.getTime() > input.expectedArrivalTo.getTime()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expectedArrivalFrom must not be after expectedArrivalTo", path: ["expectedArrivalTo"] });
  }
}

const createShipmentBaseSchema = z.object({
  method: z.enum(SHIPMENT_METHODS),
  carrier: z.string().trim().max(200).optional(),
  trackingReference: z.string().trim().max(200).optional(),
  trackingType: z.enum(TRACKING_TYPES).optional(),
  containerNo: z.string().trim().max(200).optional(),
  vesselOrFlight: z.string().trim().max(200).optional(),
  portOfDeparture: z.string().trim().max(200).optional(),
  portOfArrival: z.string().trim().max(200).optional(),
  expectedArrivalFrom: z.coerce.date().optional(),
  expectedArrivalTo: z.coerce.date().optional(),
  incoterms: z.enum(INCOTERMS).optional(),
  // Explicit override -- if omitted, server-suggests from incoterms (see
  // suggestCostResponsibility in src/lib/shipmentStatus.ts), never silently
  // re-derived once set.
  costResponsibility: z.enum(COST_RESPONSIBILITIES).optional(),
  shippingCost: decimalField(z.coerce.number().nonnegative()).optional().default(0),
  insurance: decimalField(z.coerce.number().nonnegative()).optional().default(0),
  insuranceResponsibility: z.enum(COST_RESPONSIBILITIES).optional(),
  customsCost: decimalField(z.coerce.number().nonnegative()).optional().default(0),
  customsNotes: z.string().trim().max(2000).optional(),
  priority: z.enum(PRIORITIES).optional().default("normal"),
  supplierReference: z.string().trim().max(200).optional(),
  carrierReference: z.string().trim().max(200).optional(),
  customsReference: z.string().trim().max(200).optional(),
  items: z.array(shipmentItemSchema).min(1, "At least one item is required").superRefine(rejectDuplicatePoItems),
});

export const createShipmentSchema = createShipmentBaseSchema.superRefine(validateArrivalWindow);
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

export const createSupplierShipmentSchema = createShipmentBaseSchema
  .extend({
    senderName: z.string().trim().min(1).max(200),
    senderPhone: z.string().trim().min(1).max(30),
  })
  .superRefine(validateArrivalWindow);
export type CreateSupplierShipmentInput = z.infer<typeof createSupplierShipmentSchema>;

// recordedFrom/createdByParty are documented in the base spec as client-
// suppliable, but are deliberately NOT trusted from request input here --
// they're always derived from which side is actually calling (owner-
// authenticated route vs supplier-portal token route), matching this
// repo's universal rule that actor identity is never client-suppliable
// (audit_logs.user_id is always server-resolved the same way).

function validateStatusContextualFields(
  input: { status: (typeof SHIPMENT_STATUSES)[number]; cancelReason?: string; cancelReasonNotes?: string },
  ctx: z.RefinementCtx
) {
  if (input.status === "cancelled" && !input.cancelReason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cancelReason is required when cancelling a shipment", path: ["cancelReason"] });
  }
  if (input.status !== "cancelled" && (input.cancelReason || input.cancelReasonNotes)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cancelReason/cancelReasonNotes are only valid when status is cancelled", path: ["cancelReason"] });
  }
}

export const updateShipmentStatusSchema = z
  .object({
    version: z.number().int().nonnegative(),
    status: z.enum(SHIPMENT_STATUSES),
    note: z.string().trim().max(1000).optional(),
    cancelReason: z.enum(CANCELLATION_REASONS).optional(),
    cancelReasonNotes: z.string().trim().max(2000).optional(),
    actualArrival: z.coerce.date().optional(),
    receivedBy: z.string().trim().max(200).optional(),
    receivedAt: z.coerce.date().optional(),
    receiverNotes: z.string().trim().max(2000).optional(),
  })
  .superRefine(validateStatusContextualFields);
export type UpdateShipmentStatusInput = z.infer<typeof updateShipmentStatusSchema>;

const updateEtaBaseSchema = z
  .object({
    newExpectedArrivalFrom: z.coerce.date().optional(),
    newExpectedArrivalTo: z.coerce.date().optional(),
    reasonCategory: z.enum(ETA_REASON_CATEGORIES),
    reason: z.string().trim().min(1).max(1000),
  })
  .superRefine((input, ctx) => {
    if (!input.newExpectedArrivalFrom && !input.newExpectedArrivalTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one of newExpectedArrivalFrom/newExpectedArrivalTo is required",
        path: ["newExpectedArrivalFrom"],
      });
    }
    if (input.newExpectedArrivalFrom && input.newExpectedArrivalTo && input.newExpectedArrivalFrom.getTime() > input.newExpectedArrivalTo.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "newExpectedArrivalFrom must not be after newExpectedArrivalTo", path: ["newExpectedArrivalTo"] });
    }
  });

export const updateShipmentEtaSchema = updateEtaBaseSchema;
export type UpdateShipmentEtaInput = z.infer<typeof updateShipmentEtaSchema>;

export const updateSupplierShipmentEtaSchema = z
  .object({
    newExpectedArrivalFrom: z.coerce.date().optional(),
    newExpectedArrivalTo: z.coerce.date().optional(),
    reasonCategory: z.enum(ETA_REASON_CATEGORIES),
    reason: z.string().trim().min(1).max(1000),
    senderName: z.string().trim().min(1).max(200),
    senderPhone: z.string().trim().min(1).max(30),
  })
  .superRefine((input, ctx) => {
    if (!input.newExpectedArrivalFrom && !input.newExpectedArrivalTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one of newExpectedArrivalFrom/newExpectedArrivalTo is required",
        path: ["newExpectedArrivalFrom"],
      });
    }
  });
export type UpdateSupplierShipmentEtaInput = z.infer<typeof updateSupplierShipmentEtaSchema>;

export const listShipmentsQuerySchema = paginationQuerySchema;
export type ListShipmentsQuery = z.infer<typeof listShipmentsQuerySchema>;
