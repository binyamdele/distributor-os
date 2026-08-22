-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('MANUAL_ADJUSTMENT', 'FULFILLMENT_CONSUMPTION', 'DISCREPANCY_RECONCILIATION', 'RETURN_RESTOCK', 'OTHER');

-- CreateEnum
CREATE TYPE "DiscrepancyType" AS ENUM ('PHYSICAL_SHORTAGE', 'PHYSICAL_OVERAGE', 'DAMAGED_STOCK', 'RESERVATION_MISMATCH', 'OTHER');

-- CreateEnum
CREATE TYPE "DiscrepancyStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DiscrepancyResolution" AS ENUM ('STOCK_RECONCILED', 'COUNT_CONFIRMED_NO_CHANGE', 'NO_ACTION_REQUIRED');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('EXPECTED', 'RECEIVED', 'INSPECTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DELIVERY_FAILED', 'CUSTOMER_REJECTED', 'WRONG_GOODS', 'DAMAGED_IN_TRANSIT', 'OTHER');

-- CreateEnum
CREATE TYPE "ReturnDisposition" AS ENUM ('RESTOCK', 'DAMAGED', 'MISSING', 'MIXED');

-- CreateEnum
CREATE TYPE "DeliveryFailureResolution" AS ENUM ('RETRY_DELIVERY', 'RETURNED_TO_WAREHOUSE', 'LOST_OR_UNRECOVERABLE');

-- CreateEnum
CREATE TYPE "OrderOperationalException" AS ENUM ('STOCK_SHORTFALL', 'DELIVERY_FAILED', 'DELIVERY_LOST', 'GOODS_RETURNED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SequenceKind" ADD VALUE 'RETURN';
ALTER TYPE "SequenceKind" ADD VALUE 'DISCREPANCY';

-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "attempt_number" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "failure_resolution" "DeliveryFailureResolution",
ADD COLUMN     "resolved_at" TIMESTAMPTZ(6),
ADD COLUMN     "resolved_by_id" UUID,
ADD COLUMN     "retry_of_delivery_id" UUID;

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "operational_exception" "OrderOperationalException",
ADD COLUMN     "operational_exception_note" TEXT;

-- ---------------------------------------------------------------------------
-- The Phase 1 stock ledger, renamed and widened rather than replaced.
--
-- Prisma's generated migration would DROP stock_adjustments and CREATE inventory_movements,
-- which is correct as a schema diff and wrong as a change: it would discard every manual stock
-- correction a distributor had already recorded. The table is being *renamed* because it is the
-- same table — same product, same signed delta, same resulting quantity, same actor — with a
-- wider remit. Two competing stock-mutation paths would be worse than one widened path.
--
-- Existing rows were all manual corrections, so they backfill to MANUAL_ADJUSTMENT, which is
-- exactly what they were.
-- ---------------------------------------------------------------------------
ALTER TABLE "stock_adjustments" RENAME TO "inventory_movements";
ALTER TABLE "inventory_movements" RENAME CONSTRAINT "stock_adjustments_pkey" TO "inventory_movements_pkey";
ALTER TABLE "inventory_movements" RENAME CONSTRAINT "stock_adjustments_organization_id_fkey" TO "inventory_movements_organization_id_fkey";
ALTER TABLE "inventory_movements" RENAME CONSTRAINT "stock_adjustments_product_id_fkey" TO "inventory_movements_product_id_fkey";
ALTER INDEX "stock_adjustments_organization_id_idx" RENAME TO "inventory_movements_organization_id_idx";
ALTER INDEX "stock_adjustments_product_id_idx" RENAME TO "inventory_movements_product_id_idx";

ALTER TABLE "inventory_movements"
  ADD COLUMN "movement_type" "InventoryMovementType" NOT NULL DEFAULT 'MANUAL_ADJUSTMENT',
  ADD COLUMN "related_order_id" UUID,
  ADD COLUMN "related_reservation_id" UUID,
  ADD COLUMN "related_discrepancy_id" UUID,
  ADD COLUMN "related_return_id" UUID;

-- CreateTable
CREATE TABLE "inventory_discrepancies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "discrepancy_number" TEXT NOT NULL,
    "warehouse_task_id" UUID,
    "sales_order_id" UUID,
    "product_id" UUID NOT NULL,
    "reservation_id" UUID,
    "discrepancy_type" "DiscrepancyType" NOT NULL,
    "status" "DiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "system_on_hand_quantity" INTEGER NOT NULL,
    "system_reserved_quantity" INTEGER NOT NULL,
    "expected_task_quantity" INTEGER,
    "physical_count_quantity" INTEGER NOT NULL,
    "variance_quantity" INTEGER NOT NULL,
    "report_note" TEXT,
    "reported_by_id" UUID,
    "reported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "resolution_type" "DiscrepancyResolution",
    "resolution_note" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "reservation_shortfall" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "returns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "return_number" TEXT NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'EXPECTED',
    "return_reason" "ReturnReason" NOT NULL,
    "note" TEXT,
    "received_by_id" UUID,
    "received_at" TIMESTAMPTZ(6),
    "inspected_by_id" UUID,
    "inspected_at" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "sales_order_item_id" UUID NOT NULL,
    "product_id" UUID,
    "sku_snapshot" TEXT NOT NULL,
    "description_snapshot" TEXT NOT NULL,
    "unit_snapshot" TEXT NOT NULL,
    "quantity_dispatched" INTEGER NOT NULL,
    "quantity_expected" INTEGER NOT NULL,
    "quantity_received" INTEGER NOT NULL DEFAULT 0,
    "quantity_restockable" INTEGER NOT NULL DEFAULT 0,
    "quantity_damaged" INTEGER NOT NULL DEFAULT 0,
    "quantity_missing" INTEGER NOT NULL DEFAULT 0,
    "disposition" "ReturnDisposition" NOT NULL DEFAULT 'RESTOCK',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "return_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_movements_organization_id_product_id_created_at_idx" ON "inventory_movements"("organization_id", "product_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_discrepancies_organization_id_idx" ON "inventory_discrepancies"("organization_id");

-- CreateIndex
CREATE INDEX "inventory_discrepancies_organization_id_status_idx" ON "inventory_discrepancies"("organization_id", "status");

-- CreateIndex
CREATE INDEX "inventory_discrepancies_warehouse_task_id_idx" ON "inventory_discrepancies"("warehouse_task_id");

-- CreateIndex
CREATE INDEX "inventory_discrepancies_organization_id_product_id_status_idx" ON "inventory_discrepancies"("organization_id", "product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_discrepancies_organization_id_discrepancy_number_key" ON "inventory_discrepancies"("organization_id", "discrepancy_number");

-- CreateIndex
CREATE INDEX "returns_organization_id_idx" ON "returns"("organization_id");

-- CreateIndex
CREATE INDEX "returns_organization_id_status_idx" ON "returns"("organization_id", "status");

-- CreateIndex
CREATE INDEX "returns_sales_order_id_idx" ON "returns"("sales_order_id");

-- CreateIndex
CREATE INDEX "returns_delivery_id_idx" ON "returns"("delivery_id");

-- CreateIndex
CREATE UNIQUE INDEX "returns_organization_id_return_number_key" ON "returns"("organization_id", "return_number");

-- CreateIndex
CREATE INDEX "return_items_organization_id_idx" ON "return_items"("organization_id");

-- CreateIndex
CREATE INDEX "return_items_return_id_idx" ON "return_items"("return_id");

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_retry_of_delivery_id_fkey" FOREIGN KEY ("retry_of_delivery_id") REFERENCES "deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_discrepancies" ADD CONSTRAINT "inventory_discrepancies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_discrepancies" ADD CONSTRAINT "inventory_discrepancies_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_discrepancies" ADD CONSTRAINT "inventory_discrepancies_warehouse_task_id_fkey" FOREIGN KEY ("warehouse_task_id") REFERENCES "warehouse_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_discrepancies" ADD CONSTRAINT "inventory_discrepancies_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_discrepancies" ADD CONSTRAINT "inventory_discrepancies_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "stock_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

