-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('CASH', 'CREDIT');

-- CreateEnum
CREATE TYPE "ApprovalLevel" AS ENUM ('SALESPERSON', 'SALES_MANAGER', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "organization_settings" ADD COLUMN     "delivery_fee_taxable" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quotation_number" TEXT NOT NULL,
    "inquiry_id" UUID,
    "customer_id" UUID NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" VARCHAR(3) NOT NULL,
    "payment_type" "PaymentType" NOT NULL DEFAULT 'CASH',
    "payment_terms_days" INTEGER NOT NULL DEFAULT 0,
    "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "discount_total_minor" BIGINT NOT NULL DEFAULT 0,
    "delivery_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "delivery_tax_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_total_minor" BIGINT NOT NULL DEFAULT 0,
    "grand_total_minor" BIGINT NOT NULL DEFAULT 0,
    "validity_date" DATE NOT NULL,
    "customer_notes" TEXT,
    "internal_notes" TEXT,
    "current_payload_hash" TEXT NOT NULL,
    "approved_payload_hash" TEXT,
    "required_level" "ApprovalLevel" NOT NULL DEFAULT 'SALESPERSON',
    "created_by_id" UUID,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "sent_by_id" UUID,
    "sent_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "expired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "product_id" UUID,
    "sku_snapshot" TEXT NOT NULL,
    "description_snapshot" TEXT NOT NULL,
    "unit_snapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "list_unit_price_minor" BIGINT NOT NULL,
    "quoted_unit_price_minor" BIGINT NOT NULL,
    "discount_bp" INTEGER NOT NULL DEFAULT 0,
    "tax_rate_bp" INTEGER NOT NULL,
    "line_subtotal_minor" BIGINT NOT NULL,
    "line_discount_minor" BIGINT NOT NULL,
    "taxable_amount_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "line_total_minor" BIGINT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "quotation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_approvals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "approver_id" UUID NOT NULL,
    "approver_role" "Role" NOT NULL,
    "required_level" "ApprovalLevel" NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotation_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotations_organization_id_idx" ON "quotations"("organization_id");

-- CreateIndex
CREATE INDEX "quotations_organization_id_status_idx" ON "quotations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "quotations_organization_id_created_at_idx" ON "quotations"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organization_id_quotation_number_key" ON "quotations"("organization_id", "quotation_number");

-- CreateIndex
CREATE INDEX "quotation_items_organization_id_idx" ON "quotation_items"("organization_id");

-- CreateIndex
CREATE INDEX "quotation_items_quotation_id_idx" ON "quotation_items"("quotation_id");

-- CreateIndex
CREATE INDEX "quotation_approvals_organization_id_idx" ON "quotation_approvals"("organization_id");

-- CreateIndex
CREATE INDEX "quotation_approvals_quotation_id_idx" ON "quotation_approvals"("quotation_id");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_approvals" ADD CONSTRAINT "quotation_approvals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_approvals" ADD CONSTRAINT "quotation_approvals_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
