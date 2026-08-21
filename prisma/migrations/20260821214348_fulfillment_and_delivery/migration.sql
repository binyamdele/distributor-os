-- CreateEnum
CREATE TYPE "WarehouseTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'PREPARED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WarehouseTaskItemStatus" AS ENUM ('PENDING', 'PREPARED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'ASSIGNED', 'DISPATCHED', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryFailureReason" AS ENUM ('CUSTOMER_UNAVAILABLE', 'WRONG_ADDRESS', 'VEHICLE_ISSUE', 'CUSTOMER_REJECTED', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SequenceKind" ADD VALUE 'WAREHOUSE_TASK';
ALTER TYPE "SequenceKind" ADD VALUE 'DELIVERY';

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "completed_at" TIMESTAMPTZ(6),
ADD COLUMN     "picked_up_at" TIMESTAMPTZ(6),
ADD COLUMN     "picked_up_by_id" UUID,
ADD COLUMN     "pickup_note" TEXT;

-- CreateTable
CREATE TABLE "warehouse_tasks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "task_number" TEXT NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "status" "WarehouseTaskStatus" NOT NULL DEFAULT 'PENDING',
    "assigned_user_id" UUID,
    "started_at" TIMESTAMPTZ(6),
    "prepared_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancellation_reason" TEXT,
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warehouse_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_task_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_task_id" UUID NOT NULL,
    "sales_order_item_id" UUID NOT NULL,
    "product_id" UUID,
    "sku_snapshot" TEXT NOT NULL,
    "description_snapshot" TEXT NOT NULL,
    "unit_snapshot" TEXT NOT NULL,
    "quantity_required" INTEGER NOT NULL,
    "quantity_prepared" INTEGER NOT NULL DEFAULT 0,
    "status" "WarehouseTaskItemStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warehouse_task_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "delivery_number" TEXT NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "warehouse_task_id" UUID NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "customer_name_snapshot" TEXT NOT NULL,
    "customer_phone_snapshot" TEXT,
    "destination_text_snapshot" TEXT NOT NULL,
    "assigned_driver_name" TEXT,
    "assigned_driver_phone" TEXT,
    "vehicle_reference" TEXT,
    "assigned_at" TIMESTAMPTZ(6),
    "dispatched_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "failure_reason" "DeliveryFailureReason",
    "failure_note" TEXT,
    "delivery_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouse_tasks_organization_id_idx" ON "warehouse_tasks"("organization_id");

-- CreateIndex
CREATE INDEX "warehouse_tasks_organization_id_status_idx" ON "warehouse_tasks"("organization_id", "status");

-- CreateIndex
CREATE INDEX "warehouse_tasks_sales_order_id_idx" ON "warehouse_tasks"("sales_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_tasks_organization_id_task_number_key" ON "warehouse_tasks"("organization_id", "task_number");

-- CreateIndex
CREATE INDEX "warehouse_task_items_organization_id_idx" ON "warehouse_task_items"("organization_id");

-- CreateIndex
CREATE INDEX "warehouse_task_items_warehouse_task_id_idx" ON "warehouse_task_items"("warehouse_task_id");

-- CreateIndex
CREATE INDEX "deliveries_organization_id_idx" ON "deliveries"("organization_id");

-- CreateIndex
CREATE INDEX "deliveries_organization_id_status_idx" ON "deliveries"("organization_id", "status");

-- CreateIndex
CREATE INDEX "deliveries_sales_order_id_idx" ON "deliveries"("sales_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_organization_id_delivery_number_key" ON "deliveries"("organization_id", "delivery_number");

-- AddForeignKey
ALTER TABLE "warehouse_tasks" ADD CONSTRAINT "warehouse_tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_tasks" ADD CONSTRAINT "warehouse_tasks_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_tasks" ADD CONSTRAINT "warehouse_tasks_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_task_items" ADD CONSTRAINT "warehouse_task_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_task_items" ADD CONSTRAINT "warehouse_task_items_warehouse_task_id_fkey" FOREIGN KEY ("warehouse_task_id") REFERENCES "warehouse_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_task_items" ADD CONSTRAINT "warehouse_task_items_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_task_items" ADD CONSTRAINT "warehouse_task_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_warehouse_task_id_fkey" FOREIGN KEY ("warehouse_task_id") REFERENCES "warehouse_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
