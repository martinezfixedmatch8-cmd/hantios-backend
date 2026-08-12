import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./lib/config";
import authRoutes from "./routes/auth.routes";
import staffInviteRoutes from "./routes/staffInvite.routes";
import branchRoutes from "./routes/branch.routes";
import paymentMethodRoutes from "./routes/paymentMethod.routes";
import productRoutes from "./routes/product.routes";
import saleRoutes from "./routes/sale.routes";
import referenceRoutes from "./routes/reference.routes";
import debtRoutes from "./routes/debt.routes";
import expenseRoutes from "./routes/expense.routes";
import expenseCategoryRoutes from "./routes/expenseCategory.routes";
import tagRoutes from "./routes/tag.routes";
import customerRoutes from "./routes/customer.routes";
import supplierRoutes from "./routes/supplier.routes";
import purchaseOrderRoutes from "./routes/purchaseOrder.routes";
import receiptRoutes from "./routes/receipt.routes";
import warehouseMovementRoutes from "./routes/warehouseMovement.routes";
import poNegotiationRoutes from "./routes/poNegotiation.routes";
import poNegotiationPortalRoutes from "./routes/poNegotiationPortal.routes";
import poShipmentRoutes from "./routes/poShipment.routes";
import poShipmentPortalRoutes from "./routes/poShipmentPortal.routes";
import resendInboundWebhookRoutes from "./routes/resendInboundWebhook.routes";
import unmatchedInboundEmailRoutes from "./routes/unmatchedInboundEmail.routes";
import departmentRoutes from "./routes/department.routes";
import positionRoutes from "./routes/position.routes";
import employeeRoutes from "./routes/employee.routes";
import payrollRoutes from "./routes/payroll.routes";
import attendanceRoutes from "./routes/attendance.routes";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler";

export const app = express();

app.use(helmet());
// credentials: true is required now that /auth issues cookie-based sessions -- paired with
// NOT falling back to reflecting any origin (`origin: true`) once CORS_ORIGINS is unset,
// since that combination would allow any site to make credentialed requests.
app.use(
  cors({
    origin: env.CORS_ORIGIN_LIST ?? (env.NODE_ENV === "production" ? false : true),
    credentials: true,
  })
);

// Module 33 Session 4B -- MUST be mounted before express.json() below.
// Resend's own Svix-based signature verification requires the exact raw
// request bytes; express.json() would already have parsed (and
// byte-for-byte altered, e.g. re-serialized whitespace) the body by the
// time any route-specific middleware saw it otherwise. express.raw() is
// scoped to this exact mount point only -- every other route in this app
// still gets the normal JSON body below, unaffected.
app.use("/api/webhooks", express.raw({ type: "*/*", limit: "2mb" }), resendInboundWebhookRoutes);

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.use("/auth", authRoutes);
app.use("/staff", staffInviteRoutes);
app.use("/branches", branchRoutes);
app.use("/payment-methods", paymentMethodRoutes);
app.use("/products", productRoutes);
app.use("/sales", saleRoutes);
app.use("/receipts", receiptRoutes);
app.use("/reference", referenceRoutes);
app.use("/debts", debtRoutes);
app.use("/expenses", expenseRoutes);
app.use("/expense-categories", expenseCategoryRoutes);
app.use("/tags", tagRoutes);
app.use("/customers", customerRoutes);
app.use("/suppliers", supplierRoutes);
app.use("/purchase-orders", purchaseOrderRoutes);
app.use("/purchase-orders", poNegotiationRoutes);
app.use("/purchase-orders", poShipmentRoutes);
app.use("/warehouse-movements", warehouseMovementRoutes);
app.use("/portal", poNegotiationPortalRoutes);
app.use("/portal", poShipmentPortalRoutes);
app.use("/api/unmatched-inbound-emails", unmatchedInboundEmailRoutes);
app.use("/departments", departmentRoutes);
app.use("/positions", positionRoutes);
app.use("/employees", employeeRoutes);
app.use("/payroll", payrollRoutes);
app.use("/attendance", attendanceRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
