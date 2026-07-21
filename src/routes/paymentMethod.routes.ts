import { Router } from "express";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/requireRole";
import {
  createPaymentMethod,
  listPaymentMethods,
  getPaymentMethod,
  updatePaymentMethod,
  archivePaymentMethod,
  restorePaymentMethod,
} from "../controllers/paymentMethod.controller";

const router = Router();

router.use(authenticate, requireRole("owner", "manager"));

router.post("/", createPaymentMethod);
router.get("/", listPaymentMethods);
router.get("/:id", getPaymentMethod);
router.patch("/:id", updatePaymentMethod);
router.delete("/:id", archivePaymentMethod);
router.post("/:id/restore", restorePaymentMethod);

export default router;
