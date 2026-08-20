-- CreateEnum
CREATE TYPE "InquiryChannel" AS ENUM ('MANUAL', 'WHATSAPP', 'TELEGRAM', 'EMAIL', 'SMS', 'PHONE_NOTE');

-- CreateEnum
CREATE TYPE "InquiryStatus" AS ENUM ('RECEIVED', 'PARSING', 'NEEDS_REVIEW', 'READY_FOR_QUOTE', 'PARSE_FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InquiryIntent" AS ENUM ('REQUEST_QUOTATION', 'STOCK_ENQUIRY', 'ORDER_FOLLOW_UP', 'PAYMENT_QUERY', 'DELIVERY_QUERY', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('CANONICAL', 'ALIAS', 'FUZZY', 'UNRESOLVED', 'HUMAN');

-- CreateEnum
CREATE TYPE "ItemReviewStatus" AS ENUM ('SUGGESTED', 'CONFIRMED', 'CORRECTED', 'UNRESOLVED', 'REJECTED');

-- DropIndex
DROP INDEX "product_aliases_normalized_trgm";

-- CreateTable
CREATE TABLE "inquiries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID,
    "channel" "InquiryChannel" NOT NULL DEFAULT 'MANUAL',
    "raw_message" TEXT NOT NULL,
    "normalized_text" TEXT NOT NULL,
    "detected_language" TEXT,
    "intent" "InquiryIntent" NOT NULL DEFAULT 'UNKNOWN',
    "destination_text" TEXT,
    "parsed_customer_name" TEXT,
    "status" "InquiryStatus" NOT NULL DEFAULT 'RECEIVED',
    "assigned_user_id" UUID,
    "created_by_id" UUID,
    "parse_error" TEXT,
    "parsed_at" TIMESTAMPTZ(6),
    "reviewed_at" TIMESTAMPTZ(6),
    "ready_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_item_proposals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "inquiry_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "raw_name" TEXT NOT NULL,
    "requested_quantity" INTEGER NOT NULL,
    "requested_unit" TEXT,
    "proposed_product_id" UUID,
    "proposed_confidence" DECIMAL(5,4),
    "match_method" "MatchMethod" NOT NULL DEFAULT 'UNRESOLVED',
    "match_reason" TEXT NOT NULL DEFAULT '',
    "candidates" JSONB,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "matched_product_id" UUID,
    "review_status" "ItemReviewStatus" NOT NULL DEFAULT 'SUGGESTED',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inquiry_item_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_interactions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "inquiry_id" UUID,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "input_fingerprint" TEXT NOT NULL,
    "valid" BOOLEAN NOT NULL,
    "error_code" TEXT,
    "item_count" INTEGER,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inquiries_organization_id_idx" ON "inquiries"("organization_id");

-- CreateIndex
CREATE INDEX "inquiries_organization_id_status_idx" ON "inquiries"("organization_id", "status");

-- CreateIndex
CREATE INDEX "inquiries_organization_id_created_at_idx" ON "inquiries"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "inquiry_item_proposals_organization_id_idx" ON "inquiry_item_proposals"("organization_id");

-- CreateIndex
CREATE INDEX "inquiry_item_proposals_inquiry_id_idx" ON "inquiry_item_proposals"("inquiry_id");

-- CreateIndex
CREATE INDEX "ai_interactions_organization_id_idx" ON "ai_interactions"("organization_id");

-- CreateIndex
CREATE INDEX "ai_interactions_organization_id_created_at_idx" ON "ai_interactions"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_item_proposals" ADD CONSTRAINT "inquiry_item_proposals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_item_proposals" ADD CONSTRAINT "inquiry_item_proposals_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_item_proposals" ADD CONSTRAINT "inquiry_item_proposals_matched_product_id_fkey" FOREIGN KEY ("matched_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiry_item_proposals" ADD CONSTRAINT "inquiry_item_proposals_proposed_product_id_fkey" FOREIGN KEY ("proposed_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "inquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
