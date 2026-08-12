import { z } from "zod";
import { CompensationPolicyType, CompensationPolicyStatus } from "@prisma/client";
import { paginationQuerySchema } from "../lib/pagination";

// Module 12 Session C, Addendum G -- backend-only storage/versioning/API
// for the human-readable EXPLANATION of compensation rules. This is never
// itself the source of payroll calculation -- the actual commission rate
// lives on employee_compensation.compensation_config, selected by whatever
// structure is effective for the payroll period, same as always.
export const createCompensationPolicySchema = z.object({
  policyType: z.nativeEnum(CompensationPolicyType),
  version: z.string().trim().min(1).max(50),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20000),
  effectiveFrom: z.coerce.date(),
});
export type CreateCompensationPolicyInput = z.infer<typeof createCompensationPolicySchema>;

export const listCompensationPoliciesQuerySchema = paginationQuerySchema.extend({
  policyType: z.nativeEnum(CompensationPolicyType).optional(),
  status: z.nativeEnum(CompensationPolicyStatus).optional(),
});
export type ListCompensationPoliciesQuery = z.infer<typeof listCompensationPoliciesQuerySchema>;

export const acknowledgeCompensationPolicySchema = z.object({
  employeeId: z.string().uuid(),
});
export type AcknowledgeCompensationPolicyInput = z.infer<typeof acknowledgeCompensationPolicySchema>;
