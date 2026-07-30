import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import { requireIdempotencyKey } from "../middleware/idempotencyKey";
import { createSupplier, listSuppliers, getSupplier, updateSupplier, archiveSupplier, restoreSupplier } from "../controllers/supplier.controller";

const router = Router();

router.use(authenticate);

// RBAC not explicitly specified for Suppliers itself in the locked spec --
// inferred by direct analogy to Purchase Orders' own stated bar (Suppliers
// is the same "supply side" concept, used by the same roles): storekeeper
// needs visibility for receiving, accountant for reporting. Cashier/
// shareholder/custom: zero access anywhere.
const writeRoles = ["owner", "manager"] as const;
const viewRoles = ["owner", "manager", "accountant", "storekeeper"] as const;

router.post("/", requireRole(...writeRoles), requireIdempotencyKey, createSupplier);
router.get("/", requireRole(...viewRoles), listSuppliers);
router.get("/:id", requireRole(...viewRoles), getSupplier);
router.patch("/:id", requireRole(...writeRoles), updateSupplier);
router.post("/:id/archive", requireRole(...writeRoles), requireIdempotencyKey, archiveSupplier);
router.post("/:id/restore", requireRole(...writeRoles), restoreSupplier);

export default router;
