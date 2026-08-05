import { z } from "zod";
import { paginationQuerySchema } from "../lib/pagination";

const MILESTONE_TYPES = [
  "production_started",
  "production_finished",
  "packing",
  "ready_to_ship",
  "shipped",
  "customs_clearance",
  "arrived",
  "warehouse_received",
  "completed",
] as const;

// recordedFrom is intentionally NOT part of this schema -- per this
// module's own actor-identity rule (see poShipment.schema.ts's comment),
// it's always derived server-side from which route actually called
// (owner vs supplier), never trusted from request input.
const createMilestoneBaseSchema = z.object({
  shipmentId: z.string().uuid().optional(),
  milestone: z.enum(MILESTONE_TYPES),
  plannedDate: z.coerce.date().optional(),
  actualDate: z.coerce.date().optional(),
});

export const createMilestoneSchema = createMilestoneBaseSchema;
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;

export const createSupplierMilestoneSchema = createMilestoneBaseSchema.extend({
  senderName: z.string().trim().min(1).max(200),
  senderPhone: z.string().trim().min(1).max(30),
});
export type CreateSupplierMilestoneInput = z.infer<typeof createSupplierMilestoneSchema>;

export const listMilestonesQuerySchema = paginationQuerySchema;
export type ListMilestonesQuery = z.infer<typeof listMilestonesQuerySchema>;
