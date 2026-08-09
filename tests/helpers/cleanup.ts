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
  await prisma.email_send_log.deleteMany({ where: { business_id: businessId } });
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
  // Module 11 Session B -- warehouse_movements FKs to warehouses/products/
  // goods_received_notes (the last is ON DELETE SET NULL, but deleting this
  // table first regardless keeps the order simple); goods_received_items
  // FKs to goods_received_notes/purchase_order_items/products, so it must go
  // before all three; goods_received_notes FKs to purchase_orders, so it
  // must go before that; purchase_order_payments FKs to BOTH expenses and
  // purchase_orders (both RESTRICT), so it must go before both -- placed
  // here, ahead of the expense-cleanup block below, for that reason.
  await prisma.warehouse_movements.deleteMany({ where: { business_id: businessId } });
  await prisma.goods_received_items.deleteMany({ where: { business_id: businessId } });
  await prisma.goods_received_notes.deleteMany({ where: { business_id: businessId } });
  await prisma.purchase_order_payments.deleteMany({ where: { business_id: businessId } });
  await prisma.grn_counters.deleteMany({ where: { business_id: businessId } });
  await prisma.wsm_counters.deleteMany({ where: { business_id: businessId } });

  // expense_attachments/expense_tags/expense_recurrence all FK to expenses --
  // delete before it. expense_tags has no direct business_id column (a pure
  // junction table), so it's scoped via the expenses relation instead.
  await prisma.expense_attachments.deleteMany({ where: { business_id: businessId } });
  await prisma.expense_tags.deleteMany({ where: { expenses: { business_id: businessId } } });
  await prisma.expense_recurrence.deleteMany({ where: { business_id: businessId } });
  await prisma.expenses.deleteMany({ where: { business_id: businessId } });
  await prisma.expense_categories.deleteMany({ where: { business_id: businessId } });
  await prisma.expense_counters.deleteMany({ where: { business_id: businessId } });
  await prisma.customer_counters.deleteMany({ where: { business_id: businessId } });
  await prisma.tags.deleteMany({ where: { business_id: businessId } });
  // PO Negotiation Core -- agreement_snapshots FKs to proposals (RESTRICT),
  // so it must go before proposals; attachments FKs to messages/proposals
  // (SET NULL, but deleted first anyway for order simplicity);
  // proposal_changes FKs to proposals AND purchase_order_items (RESTRICT),
  // so it must go before BOTH; proposals/messages/internal_notes/
  // secure_links all FK to purchase_orders, so all must go before that.
  await prisma.po_negotiation_agreement_snapshots.deleteMany({ where: { business_id: businessId } });
  await prisma.po_negotiation_attachments.deleteMany({ where: { business_id: businessId } });
  await prisma.po_negotiation_proposal_changes.deleteMany({ where: { business_id: businessId } });
  await prisma.po_negotiation_proposals.deleteMany({ where: { business_id: businessId } });
  await prisma.po_negotiation_messages.deleteMany({ where: { business_id: businessId } });
  await prisma.po_negotiation_internal_notes.deleteMany({ where: { business_id: businessId } });
  await prisma.po_secure_links.deleteMany({ where: { business_id: businessId } });

  // Session 2A -- po_advance_payments FKs to po_proforma_invoices AND
  // supplier_payment_instructions (both RESTRICT), so it must go before
  // both; po_proforma_invoices FKs to purchase_orders (RESTRICT) and
  // po_negotiation_agreement_snapshots (SET NULL, order-independent), so it
  // must go before purchase_orders regardless.
  await prisma.po_advance_payments.deleteMany({ where: { business_id: businessId } });
  await prisma.po_proforma_invoices.deleteMany({ where: { business_id: businessId } });
  await prisma.proforma_invoice_counters.deleteMany({ where: { business_id: businessId } });

  // Session 2B -- po_commercial_invoices self-references via supersedes_id
  // (SET NULL, order-independent among its own rows) and FKs to
  // purchase_orders (RESTRICT), so it must go before that.
  await prisma.po_commercial_invoices.deleteMany({ where: { business_id: businessId } });
  await prisma.commercial_invoice_counters.deleteMany({ where: { business_id: businessId } });

  // Session 3 -- po_eta_updates/po_shipment_attachments/
  // po_shipment_status_history/po_shipment_items all FK to po_shipments
  // (RESTRICT), so all four must go before it; po_delivery_milestones FKs
  // to po_shipments too but via SET NULL (order-independent among those
  // two, still placed here for clarity); po_shipments/po_delivery_milestones
  // both FK to purchase_orders (RESTRICT), so both must go before that.
  await prisma.po_eta_updates.deleteMany({ where: { business_id: businessId } });
  await prisma.po_shipment_attachments.deleteMany({ where: { business_id: businessId } });
  await prisma.po_shipment_status_history.deleteMany({ where: { business_id: businessId } });
  await prisma.po_shipment_items.deleteMany({ where: { business_id: businessId } });
  await prisma.po_delivery_milestones.deleteMany({ where: { business_id: businessId } });
  await prisma.po_shipments.deleteMany({ where: { business_id: businessId } });
  await prisma.shipment_counters.deleteMany({ where: { business_id: businessId } });

  // purchase_order_items FKs to products/purchase_orders -- delete before both.
  // purchase_orders FKs to branches/suppliers/users -- delete before all three.
  await prisma.purchase_order_items.deleteMany({ where: { business_id: businessId } });
  await prisma.purchase_orders.deleteMany({ where: { business_id: businessId } });
  await prisma.po_counters.deleteMany({ where: { business_id: businessId } });
  // supplier_payment_instructions FKs to suppliers -- delete before it
  // (po_advance_payments, its own only other referencer, is already gone
  // by this point, see above).
  await prisma.supplier_payment_instructions.deleteMany({ where: { business_id: businessId } });
  await prisma.suppliers.deleteMany({ where: { business_id: businessId } });
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
