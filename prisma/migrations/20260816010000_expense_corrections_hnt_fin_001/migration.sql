-- HNT-FIN-001 remediation -- an append-only correction ledger so a paid
-- expense's financial fields can be corrected without ever rewriting the
-- paid row. The original expenses row is never touched by this table.

-- CreateTable
CREATE TABLE "expense_corrections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    "new_amount" DECIMAL(14,2),
    "new_tax_amount" DECIMAL(14,2),
    "new_tax_rate" DECIMAL(5,2),
    "new_tax_included" BOOLEAN,
    "new_category_id" TEXT,
    "new_category_name" TEXT,
    "new_payment_method_id" TEXT,
    "new_expense_date" DATE,
    "new_branch_id" TEXT,
    "new_scope" "ExpenseScope",
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_corrections_business_id_idx" ON "expense_corrections"("business_id");

-- CreateIndex
CREATE INDEX "expense_corrections_expense_id_idx" ON "expense_corrections"("expense_id");

-- AddForeignKey
ALTER TABLE "expense_corrections" ADD CONSTRAINT "expense_corrections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_corrections" ADD CONSTRAINT "expense_corrections_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_corrections" ADD CONSTRAINT "expense_corrections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added CHECK constraint -- at least one of the correctable fields must
-- actually be populated (Zod also enforces this at the API boundary; this
-- is the real, DB-level backstop, same recipe as every other hand-added
-- constraint in this repo).
ALTER TABLE "expense_corrections" ADD CONSTRAINT "chk_expense_corrections_at_least_one_field" CHECK (
  new_amount IS NOT NULL OR new_tax_amount IS NOT NULL OR new_tax_rate IS NOT NULL OR new_tax_included IS NOT NULL
  OR new_category_id IS NOT NULL OR new_payment_method_id IS NOT NULL OR new_expense_date IS NOT NULL
  OR new_branch_id IS NOT NULL OR new_scope IS NOT NULL
);
