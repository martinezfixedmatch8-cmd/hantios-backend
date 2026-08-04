import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { createSupplier, listSuppliers, getSupplier, updateSupplier, archiveSupplier, restoreSupplier } from "../controllers/supplier.controller";
import {
  createSupplierPaymentInstruction,
  listSupplierPaymentInstructions,
  setDefaultSupplierPaymentInstruction,
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

export default router;
