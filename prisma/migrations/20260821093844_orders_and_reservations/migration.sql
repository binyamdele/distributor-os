-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('DUE', 'COMPLETED', 'SNOOZED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FollowUpOutcome" AS ENUM ('NO_RESPONSE', 'CUSTOMER_CONSIDERING', 'CUSTOMER_REQUESTED_CHANGE', 'CUSTOMER_ACCEPTED', 'CUSTOMER_REJECTED', 'OTHER');

-- CreateEnum
CREATE TYPE "AcceptanceSource" AS ENUM ('PHONE', 'MESSAGE', 'EMAIL', 'IN_PERSON', 'OTHER');

-- CreateEnum
CREATE TYPE "RejectionReason" AS ENUM ('PRICE', 'STOCK', 'DELIVERY', 'TIMING', 'COMPETITOR', 'CUSTOMER_CANCELLED', 'OTHER');

-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('OPEN', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "OrderPaymentStatus" AS ENUM ('UNPAID', 'NOT_REQUIRED_YET', 'PAID');

-- CreateEnum
CREATE TYPE "OrderFulfillmentStatus" AS ENUM ('NOT_READY', 'READY', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');

-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "max_follow_up_count" INTEGER NOT NULL DEFAULT 4;

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN     "acceptance_note" TEXT,
ADD COLUMN     "acceptance_source" "AcceptanceSource",
ADD COLUMN     "accepted_by_id" UUID,
ADD COLUMN     "rejected_by_id" UUID,
ADD COLUMN     "rejection_note" TEXT,
ADD COLUMN     "rejection_reason" "RejectionReason";

-- CreateTable
CREATE TABLE "quotation_follow_ups" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'DUE',
    "assigned_user_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_id" UUID,
    "outcome" "FollowUpOutcome",
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quotation_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "order_number" TEXT NOT NULL,
    "quotation_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'OPEN',
    "payment_status" "OrderPaymentStatus" NOT NULL,
    "fulfillment_status" "OrderFulfillmentStatus" NOT NULL DEFAULT 'NOT_READY',
    "currency" VARCHAR(3) NOT NULL,
    "payment_type" "PaymentType" NOT NULL,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 0,
    "payment_due_date" DATE,
    "subtotal_minor" BIGINT NOT NULL,
    "discount_total_minor" BIGINT NOT NULL,
    "delivery_fee_minor" BIGINT NOT NULL,
    "delivery_tax_minor" BIGINT NOT NULL,
    "tax_total_minor" BIGINT NOT NULL,
    "grand_total_minor" BIGINT NOT NULL,
    "delivery_required" BOOLEAN NOT NULL DEFAULT false,
    "delivery_address_snapshot" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "cancellation_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "product_id" UUID,
    "sku_snapshot" TEXT NOT NULL,
    "description_snapshot" TEXT NOT NULL,
    "unit_snapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "list_unit_price_minor" BIGINT NOT NULL,
    "quoted_unit_price_minor" BIGINT NOT NULL,
    "discount_bp" INTEGER NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL,
    "line_subtotal_minor" BIGINT NOT NULL,
    "line_discount_minor" BIGINT NOT NULL,
    "taxable_amount_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "line_total_minor" BIGINT NOT NULL,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "sales_order_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "released_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotation_follow_ups_organization_id_idx" ON "quotation_follow_ups"("organization_id");

-- CreateIndex
CREATE INDEX "quotation_follow_ups_organization_id_status_due_at_idx" ON "quotation_follow_ups"("organization_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "quotation_follow_ups_quotation_id_idx" ON "quotation_follow_ups"("quotation_id");

-- CreateIndex
CREATE INDEX "sales_orders_organization_id_idx" ON "sales_orders"("organization_id");

-- CreateIndex
CREATE INDEX "sales_orders_organization_id_status_idx" ON "sales_orders"("organization_id", "status");

-- CreateIndex
CREATE INDEX "sales_orders_organization_id_created_at_idx" ON "sales_orders"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_organization_id_order_number_key" ON "sales_orders"("organization_id", "order_number");

-- CreateIndex
CREATE INDEX "sales_order_items_organization_id_idx" ON "sales_order_items"("organization_id");

-- CreateIndex
CREATE INDEX "sales_order_items_sales_order_id_idx" ON "sales_order_items"("sales_order_id");

-- CreateIndex
CREATE INDEX "stock_reservations_organization_id_idx" ON "stock_reservations"("organization_id");

-- CreateIndex
CREATE INDEX "stock_reservations_sales_order_id_idx" ON "stock_reservations"("sales_order_id");

-- CreateIndex
CREATE INDEX "stock_reservations_organization_id_product_id_status_idx" ON "stock_reservations"("organization_id", "product_id", "status");

-- AddForeignKey
ALTER TABLE "quotation_follow_ups" ADD CONSTRAINT "quotation_follow_ups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_follow_ups" ADD CONSTRAINT "quotation_follow_ups_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
