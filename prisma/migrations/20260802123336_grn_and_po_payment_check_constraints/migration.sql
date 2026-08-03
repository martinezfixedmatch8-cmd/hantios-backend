-- Adds the CHECK constraints goods_received_items/purchase_order_payments/
-- purchase_orders' new payment columns were missing since Session B's
-- schema landed (the `///` comment markers on those tables anticipated
-- them but nothing had backed them with real SQL yet) -- every other
-- financial/quantity ledger table in this repo has one (same gap
-- debt_transactions had before migration 20260726144416, same recipe
-- applied here).

ALTER TABLE "goods_received_items" ADD CONSTRAINT "chk_goods_received_items_quantity_positive" CHECK ("quantity_received" > 0);
ALTER TABLE "goods_received_items" ADD CONSTRAINT "chk_goods_received_items_unit_cost_nonneg" CHECK ("unit_cost_actual" >= 0);

ALTER TABLE "purchase_order_payments" ADD CONSTRAINT "chk_purchase_order_payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "purchase_order_payments" ADD CONSTRAINT "chk_purchase_order_payments_invoice_amount_nonneg" CHECK ("invoice_amount" >= 0);

ALTER TABLE "purchase_orders" ADD CONSTRAINT "chk_purchase_orders_remaining_amount_nonneg" CHECK ("remaining_amount" >= 0);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "chk_purchase_orders_paid_amount_nonneg" CHECK ("paid_amount" >= 0);
