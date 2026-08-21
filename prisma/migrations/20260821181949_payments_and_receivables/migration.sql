-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('SUBMITTED', 'NEEDS_REVIEW', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('BANK_TRANSFER', 'TELEBIRR', 'MOBILE_MONEY', 'CASH_DEPOSIT', 'OTHER');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('NOT_ATTEMPTED', 'SUCCEEDED', 'SCHEMA_INVALID', 'FAILED');

-- AlterEnum
ALTER TYPE "OrderPaymentStatus" ADD VALUE 'PARTIALLY_PAID';

-- CreateTable
CREATE TABLE "payment_evidence_files" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "original_filename" TEXT,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_evidence_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'SUBMITTED',
    "currency" VARCHAR(3) NOT NULL,
    "amount_claimed_minor" BIGINT NOT NULL,
    "amount_confirmed_minor" BIGINT,
    "method" "PaymentMethod" NOT NULL,
    "provider_name" TEXT,
    "transaction_reference" TEXT,
    "payer_name" TEXT,
    "payment_date" DATE,
    "evidence_file_id" UUID,
    "extraction_status" "ExtractionStatus" NOT NULL DEFAULT 'NOT_ATTEMPTED',
    "extraction_error" TEXT,
    "match_factors" JSONB,
    "submitted_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "confirmation_payload_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_evidence_files_organization_id_idx" ON "payment_evidence_files"("organization_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_idx" ON "payments"("organization_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_status_idx" ON "payments"("organization_id", "status");

-- CreateIndex
CREATE INDEX "payments_sales_order_id_idx" ON "payments"("sales_order_id");

-- CreateIndex
CREATE INDEX "payments_organization_id_transaction_reference_idx" ON "payments"("organization_id", "transaction_reference");

-- AddForeignKey
ALTER TABLE "payment_evidence_files" ADD CONSTRAINT "payment_evidence_files_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_evidence_file_id_fkey" FOREIGN KEY ("evidence_file_id") REFERENCES "payment_evidence_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
