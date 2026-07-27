import { prisma } from "../../src/lib/prisma";

// General-purpose cleanup for any test that creates a business and its dependents.
// Ordered to satisfy every FK in the schema, including the circular ones
// (businesses.owner_id <-> users.business_id, users.deactivated_by self-ref,
// branches.manager_id, categories.parent_id). sales.refund_of_sale_id is handled
// by deletion order (reversal rows first), not a null-out, since a reversal row's
// negative `total` requires the FK to still be set (chk_sales_total_nonneg).
export async function cleanupTestBusiness(businessId: string): Promise<void> {
  await prisma.businesses.update({ where: { id: businessId }, data: { owner_id: null } }).catch(() => {});
  await prisma.users.updateMany({ where: { business_id: businessId }, data: { deactivated_by: null, branch_id: null } });
  await prisma.branches.updateMany({ where: { business_id: businessId }, data: { manager_id: null } });
  await prisma.categories.updateMany({ where: { business_id: businessId }, data: { parent_id: null } });

  await prisma.audit_logs.deleteMany({ where: { business_id: businessId } });
  await prisma.password_history.deleteMany({ where: { users: { business_id: businessId } } });
  await prisma.staff_invites.deleteMany({ where: { business_id: businessId } });
  await prisma.sessions.deleteMany({ where: { business_id: businessId } });
  await prisma.login_events.deleteMany({ where: { business_id: businessId } });
  await prisma.otp_challenges.deleteMany({ where: { business_id: businessId } });
  await prisma.idempotency_keys.deleteMany({ where: { business_id: businessId } });
  await prisma.receipt_counters.deleteMany({ where: { business_id: businessId } });
  await prisma.inventory_adjustments.deleteMany({ where: { business_id: businessId } });
  await prisma.price_history.deleteMany({ where: { business_id: businessId } });
  await prisma.debt_reminders.deleteMany({ where: { business_id: businessId } });
  await prisma.debt_transactions.deleteMany({ where: { business_id: businessId } });
  // Same reasoning as sales' refund reversal rows: a debt_payments reversal
  // row self-references the original payment it reverses via
  // reversal_of_payment_id, so delete reversal rows before the rows they
  // reference rather than nulling the FK first.
  await prisma.debt_payments.deleteMany({ where: { business_id: businessId, reversal_of_payment_id: { not: null } } });
  await prisma.debt_payments.deleteMany({ where: { business_id: businessId } });
  await prisma.debts.deleteMany({ where: { business_id: businessId } });
  // Refund reversal rows self-reference their original sale via refund_of_sale_id
  // and carry a negative `total` -- chk_sales_total_nonneg only permits that while
  // the FK is still set, so delete them before their referenced row rather than
  // nulling the FK first (which would violate the CHECK constraint on a still-
  // negative-total row).
  await prisma.sales.deleteMany({ where: { business_id: businessId, refund_of_sale_id: { not: null } } });
  await prisma.sales.deleteMany({ where: { business_id: businessId } });
  // expense_attachments/expense_tags/expense_recurrence all FK to expenses --
  // delete before it. expense_tags has no direct business_id column (a pure
  // junction table), so it's scoped via the expenses relation instead.
  await prisma.expense_attachments.deleteMany({ where: { business_id: businessId } });
  await prisma.expense_tags.deleteMany({ where: { expenses: { business_id: businessId } } });
  await prisma.expense_recurrence.deleteMany({ where: { business_id: businessId } });
  await prisma.expenses.deleteMany({ where: { business_id: businessId } });
  await prisma.expense_categories.deleteMany({ where: { business_id: businessId } });
  await prisma.expense_counters.deleteMany({ where: { business_id: businessId } });
  await prisma.tags.deleteMany({ where: { business_id: businessId } });
  await prisma.branch_inventory.deleteMany({ where: { business_id: businessId } });
  await prisma.warehouse_stock.deleteMany({ where: { business_id: businessId } });
  await prisma.products.deleteMany({ where: { business_id: businessId } });
  await prisma.categories.deleteMany({ where: { business_id: businessId } });
  await prisma.payment_methods.deleteMany({ where: { business_id: businessId } });
  await prisma.customers.deleteMany({ where: { business_id: businessId } });

  await prisma.warehouses.deleteMany({ where: { business_id: businessId } });
  await prisma.branches.deleteMany({ where: { business_id: businessId } });
  await prisma.users.deleteMany({ where: { business_id: businessId } });

  await prisma.businesses.deleteMany({ where: { id: businessId } });
}
