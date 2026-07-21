import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import {
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  archiveProduct,
  restoreProduct,
  adjustStock,
} from "../controllers/product.controller";

const router = Router();

router.use(authenticate);

// Read access: management + accounting + inventory roles need to see products.
// Cashier is deliberately excluded here -- POS-only, product lookups for
// checkout belong to the Sales module, not general product management.
// Shareholder and custom get no access at all (never listed in any requireRole call).
const readRoles = ["owner", "manager", "accountant", "storekeeper"] as const;

router.post("/", requireRole("owner", "manager"), createProduct);
router.get("/", requireRole(...readRoles), listProducts);
router.get("/:id", requireRole(...readRoles), getProduct);
router.patch("/:id", requireRole("owner", "manager"), updateProduct);
router.delete("/:id", requireRole("owner", "manager"), archiveProduct);
router.post("/:id/restore", requireRole("owner", "manager"), restoreProduct);
// Storekeeper is the role actually doing physical stock counts/adjustments.
router.post("/:id/stock-adjustment", requireRole("owner", "manager", "storekeeper"), adjustStock);

export default router;
