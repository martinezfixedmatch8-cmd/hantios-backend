import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requirePermission } from "../lib/permissions";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { createSupplier, listSuppliers, getSupplier, updateSupplier, archiveSupplier, restoreSupplier } from "../controllers/supplier.controller";
import {
  createSupplierPaymentInstruction,
  listSupplierPaymentInstructions,
  setDefaultSupplierPaymentInstruction,
  archiveSupplierPaymentInstruction,
  restoreSupplierPaymentInstruction,
  revokeSupplierPaymentInstruction,
  revealSupplierPaymentInstruction,
} from "../controllers/supplierPaymentInstruction.controller";

const router = Router();

router.use(authenticate);

// RBAC not explicitly specified for Suppliers itself in the locked spec --
// inferred by direct analogy to Purchase Orders' own stated bar (Suppliers
// is the same "supply side" concept, used by the same roles): storekeeper
// needs visibility for receiving, accountant for reporting. Cashier/
// shareholder/custom: zero access anywhere.
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant", "storekeeper"] as const;

// Session 2A -- Payment Instructions carry banking/wallet details, a
// stricter, financial-data bar than Suppliers' own general view bar above:
// storekeeper is excluded (locked RBAC table: Manage = Owner/Manager,
// View = Owner/Manager/Accountant).
const paymentInstructionWriteRoles = ["owner", "manager"] as const;
const paymentInstructionViewRoles = ["owner", "manager", "accountant"] as const;

router.post("/", requireRole(...writeRoles), requireIdempotencyKey, createSupplier);
router.get("/", requireRole(...viewRoles), listSuppliers);
router.get("/:id", requireRole(...viewRoles), getSupplier);
router.patch("/:id", requireRole(...writeRoles), updateSupplier);
router.post("/:id/archive", requireRole(...writeRoles), requireIdempotencyKey, archiveSupplier);
router.post("/:id/restore", requireRole(...writeRoles), restoreSupplier);

router.post(
  "/:supplierId/payment-instructions",
  requireRole(...paymentInstructionWriteRoles),
  requireIdempotencyKey,
  createSupplierPaymentInstruction
);
router.get("/:supplierId/payment-instructions", requireRole(...paymentInstructionViewRoles), listSupplierPaymentInstructions);
router.post(
  "/:supplierId/payment-instructions/:id/set-default",
  requireRole(...paymentInstructionWriteRoles),
  requireIdempotencyKey,
  setDefaultSupplierPaymentInstruction
);
// Batch 4 remediation (HNT2-PO-003).
router.post(
  "/:supplierId/payment-instructions/:id/archive",
  requireRole(...paymentInstructionWriteRoles),
  requireIdempotencyKey,
  archiveSupplierPaymentInstruction
);
router.post(
  "/:supplierId/payment-instructions/:id/restore",
  requireRole(...paymentInstructionWriteRoles),
  requireIdempotencyKey,
  restoreSupplierPaymentInstruction
);
router.post(
  "/:supplierId/payment-instructions/:id/revoke",
  requireRole(...paymentInstructionWriteRoles),
  requireIdempotencyKey,
  revokeSupplierPaymentInstruction
);
// Explicit permission, not a hard-coded role check -- the only code path
// that ever returns an unmasked payment instruction. No Idempotency-Key
// (see the controller's own comment).
router.post(
  "/:supplierId/payment-instructions/:id/reveal",
  requirePermission("reveal_payment_instruction"),
  revealSupplierPaymentInstruction
);

export default router;
