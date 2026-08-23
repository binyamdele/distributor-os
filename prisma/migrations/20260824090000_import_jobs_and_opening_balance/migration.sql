
-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('CUSTOMERS', 'PRODUCTS', 'OPENING_STOCK');

-- AlterEnum
ALTER TYPE "InventoryMovementType" ADD VALUE 'OPENING_BALANCE';

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "filename" TEXT,
    "row_count" INTEGER NOT NULL,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "imported_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_organization_id_idx" ON "import_jobs"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_jobs_organization_id_kind_fingerprint_key" ON "import_jobs"("organization_id", "kind", "fingerprint");

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

