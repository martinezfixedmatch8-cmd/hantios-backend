-- CreateEnum
CREATE TYPE "ShipmentMethod" AS ENUM ('air', 'sea', 'courier');

-- CreateEnum
CREATE TYPE "ShipmentTrackingType" AS ENUM ('bill_of_lading', 'air_waybill', 'container_number', 'courier_tracking');

-- CreateEnum
CREATE TYPE "Incoterm" AS ENUM ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP');

-- CreateEnum
CREATE TYPE "ShipmentCostResponsibility" AS ENUM ('buyer', 'supplier', 'shared');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('pending', 'dispatched', 'in_transit', 'customs', 'arrived', 'delivered', 'delayed', 'cancelled');

-- CreateEnum
CREATE TYPE "ShipmentPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "ShipmentCancellationReason" AS ENUM ('supplier_issue', 'port_closure', 'customer_cancelled', 'inventory_issue', 'other');

-- CreateEnum
CREATE TYPE "DeliveryMilestoneType" AS ENUM ('production_started', 'production_finished', 'packing', 'ready_to_ship', 'shipped', 'customs_clearance', 'arrived', 'warehouse_received', 'completed');

-- CreateEnum
CREATE TYPE "EtaReasonCategory" AS ENUM ('weather', 'port_congestion', 'customs', 'carrier_delay', 'supplier_delay', 'other');

-- CreateEnum
CREATE TYPE "ShipmentAttachmentType" AS ENUM ('packing_list', 'bill_of_lading', 'air_waybill', 'certificate_of_origin', 'insurance_certificate', 'inspection_certificate', 'other');

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- CreateTable
CREATE TABLE "shipment_counters" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shipment_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_shipments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "shipment_number" TEXT NOT NULL,
    "method" "ShipmentMethod" NOT NULL,
    "carrier" TEXT,
    "tracking_reference" TEXT,
    "tracking_type" "ShipmentTrackingType",
    "container_no" TEXT,
    "vessel_or_flight" TEXT,
    "port_of_departure" TEXT,
    "port_of_arrival" TEXT,
    "expected_arrival_from" TIMESTAMP(3),
    "expected_arrival_to" TIMESTAMP(3),
    "actual_arrival" TIMESTAMP(3),
    "incoterms" "Incoterm",
    "cost_responsibility" "ShipmentCostResponsibility",
    "shipping_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "insurance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "insurance_responsibility" "ShipmentCostResponsibility",
    "customs_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "customs_notes" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'pending',
    "priority" "ShipmentPriority" NOT NULL DEFAULT 'normal',
    "delivery_address_snapshot" JSONB NOT NULL,
    "supplier_reference" TEXT,
    "carrier_reference" TEXT,
    "customs_reference" TEXT,
    "cancel_reason" "ShipmentCancellationReason",
    "cancel_reason_notes" TEXT,
    "received_by" TEXT,
    "received_at" TIMESTAMP(3),
    "receiver_notes" TEXT,
    "created_by_party" "PoNegotiationParty" NOT NULL,
    "created_by_name" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "po_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_shipment_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "po_item_id" TEXT NOT NULL,
    "quantity_shipped" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_shipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_delivery_milestones" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "shipment_id" TEXT,
    "milestone" "DeliveryMilestoneType" NOT NULL,
    "planned_date" TIMESTAMP(3),
    "actual_date" TIMESTAMP(3),
    "recorded_from" "PoNegotiationParty" NOT NULL,
    "recorded_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_delivery_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_eta_updates" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "old_expected_arrival_from" TIMESTAMP(3),
    "old_expected_arrival_to" TIMESTAMP(3),
    "new_expected_arrival_from" TIMESTAMP(3),
    "new_expected_arrival_to" TIMESTAMP(3),
    "reason_category" "EtaReasonCategory" NOT NULL,
    "reason" TEXT NOT NULL,
    "updated_by_party" "PoNegotiationParty" NOT NULL,
    "updated_by_name" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_eta_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_shipment_attachments" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "type" "ShipmentAttachmentType" NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by_party" "PoNegotiationParty" NOT NULL,
    "uploaded_by_name" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_shipment_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_shipment_status_history" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "from_status" "ShipmentStatus",
    "to_status" "ShipmentStatus" NOT NULL,
    "changed_by_party" "PoNegotiationParty" NOT NULL,
    "changed_by_name" TEXT,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "po_shipment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipment_counters_business_id_year_key" ON "shipment_counters"("business_id", "year");

-- CreateIndex
CREATE INDEX "po_shipments_purchase_order_id_idx" ON "po_shipments"("purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "po_shipments_business_id_shipment_number_key" ON "po_shipments"("business_id", "shipment_number");

-- CreateIndex
CREATE INDEX "po_shipment_items_shipment_id_idx" ON "po_shipment_items"("shipment_id");

-- CreateIndex
CREATE INDEX "po_shipment_items_po_item_id_idx" ON "po_shipment_items"("po_item_id");

-- CreateIndex
CREATE INDEX "po_delivery_milestones_purchase_order_id_idx" ON "po_delivery_milestones"("purchase_order_id");

-- CreateIndex
CREATE INDEX "po_delivery_milestones_shipment_id_idx" ON "po_delivery_milestones"("shipment_id");

-- CreateIndex
CREATE INDEX "po_eta_updates_shipment_id_idx" ON "po_eta_updates"("shipment_id");

-- CreateIndex
CREATE INDEX "po_shipment_attachments_shipment_id_idx" ON "po_shipment_attachments"("shipment_id");

-- CreateIndex
CREATE INDEX "po_shipment_status_history_shipment_id_idx" ON "po_shipment_status_history"("shipment_id");

-- AddForeignKey
ALTER TABLE "shipment_counters" ADD CONSTRAINT "shipment_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipments" ADD CONSTRAINT "po_shipments_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipments" ADD CONSTRAINT "po_shipments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipment_items" ADD CONSTRAINT "po_shipment_items_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "po_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipment_items" ADD CONSTRAINT "po_shipment_items_po_item_id_fkey" FOREIGN KEY ("po_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipment_items" ADD CONSTRAINT "po_shipment_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_delivery_milestones" ADD CONSTRAINT "po_delivery_milestones_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_delivery_milestones" ADD CONSTRAINT "po_delivery_milestones_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "po_shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_delivery_milestones" ADD CONSTRAINT "po_delivery_milestones_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_eta_updates" ADD CONSTRAINT "po_eta_updates_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_eta_updates" ADD CONSTRAINT "po_eta_updates_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "po_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_eta_updates" ADD CONSTRAINT "po_eta_updates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipment_attachments" ADD CONSTRAINT "po_shipment_attachments_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "po_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipment_attachments" ADD CONSTRAINT "po_shipment_attachments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipment_status_history" ADD CONSTRAINT "po_shipment_status_history_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "po_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_shipment_status_history" ADD CONSTRAINT "po_shipment_status_history_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added CHECK constraints -- Prisma's schema DSL has no native
-- CHECK-constraint syntax (same documented gap as every prior table
-- needing one in this repo).
ALTER TABLE "po_shipments" ADD CONSTRAINT "chk_po_shipments_costs_nonneg" CHECK ("shipping_cost" >= 0 AND "insurance" >= 0 AND "customs_cost" >= 0);
ALTER TABLE "po_shipment_items" ADD CONSTRAINT "chk_po_shipment_items_quantity_positive" CHECK ("quantity_shipped" > 0);

