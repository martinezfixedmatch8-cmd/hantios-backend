import { prisma } from "../../src/lib/prisma";

// General-purpose cleanup for any test that creates a business and its dependents.
// Ordered to satisfy every FK in the schema, including the circular ones
// (businesses.owner_id <-> users.business_id, users.deactivated_by self-ref,
// branches.manager_id, sales.refund_of_sale_id, categories.parent_id).
export async function cleanupTestBusiness(businessId: string): Promise<void> {
  await prisma.businesses.update({ where: { id: businessId }, data: { owner_id: null } }).catch(() => {});
  await prisma.users.updateMany({ where: { business_id: businessId }, data: { deactivated_by: null, branch_id: null } });
  await prisma.branches.updateMany({ where: { business_id: businessId }, data: { manager_id: null } });
  await prisma.sales.updateMany({ where: { business_id: businessId }, data: { refund_of_sale_id: null } });
  await prisma.categories.updateMany({ where: { business_id: businessId }, data: { parent_id: null } });

  await prisma.audit_logs.deleteMany({ where: { business_id: businessId } });
  await prisma.password_history.deleteMany({ where: { users: { business_id: businessId } } });
  await prisma.staff_invites.deleteMany({ where: { business_id: businessId } });
  await prisma.sessions.deleteMany({ where: { business_id: businessId } });
  await prisma.login_events.deleteMany({ where: { business_id: businessId } });
  await prisma.otp_challenges.deleteMany({ where: { business_id: businessId } });
  await prisma.idempotency_keys.deleteMany({ where: { business_id: businessId } });
  await prisma.inventory_adjustments.deleteMany({ where: { business_id: businessId } });
  await prisma.price_history.deleteMany({ where: { business_id: businessId } });
  await prisma.debts.deleteMany({ where: { business_id: businessId } });
  await prisma.sales.deleteMany({ where: { business_id: businessId } });
  await prisma.expenses.deleteMany({ where: { business_id: businessId } });
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
