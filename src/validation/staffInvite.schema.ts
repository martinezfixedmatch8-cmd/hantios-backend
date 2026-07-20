import { z } from "zod";
import { passwordSchema } from "../lib/password";

// Deliberately excludes 'owner' and 'super_admin' -- an invite can never grant either,
// regardless of what the request body asks for. Rejected with 400 rather than silently
// downgraded to some other role.
export const invitableRoles = [
  "manager",
  "accountant",
  "storekeeper",
  "cashier",
  "shareholder",
  "custom",
] as const;

export const createInviteSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^\+?[0-9]{7,15}$/, "Phone must be 7-15 digits, optionally prefixed with +"),
  role: z.enum(invitableRoles),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const acceptInviteSchema = z.object({
  password: passwordSchema,
  termsAccepted: z.literal(true, {
    message: "You must accept the Terms of Service to activate your account",
  }),
  privacyAccepted: z.literal(true, {
    message: "You must accept the Privacy Policy to activate your account",
  }),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const tokenParamSchema = z.object({
  token: z.string().min(1),
});
