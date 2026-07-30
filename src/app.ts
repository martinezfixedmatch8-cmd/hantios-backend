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
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.use("/auth", authRoutes);
app.use("/staff", staffInviteRoutes);
app.use("/branches", branchRoutes);
app.use("/payment-methods", paymentMethodRoutes);
app.use("/products", productRoutes);
app.use("/sales", saleRoutes);
app.use("/reference", referenceRoutes);
app.use("/debts", debtRoutes);
app.use("/expenses", expenseRoutes);
app.use("/expense-categories", expenseCategoryRoutes);
app.use("/tags", tagRoutes);
app.use("/customers", customerRoutes);
app.use("/suppliers", supplierRoutes);
app.use("/purchase-orders", purchaseOrderRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
