-- CreateEnum
CREATE TYPE "PendingImportStatus" AS ENUM ('PENDING', 'COMMITTED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "imports" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "totalImported" INTEGER NOT NULL,
    "totalSkipped" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3),
    "name" TEXT,
    "email" TEXT,
    "countryCode" TEXT,
    "mobileWithoutCountryCode" TEXT,
    "company" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "leadOwner" TEXT,
    "crmStatus" TEXT,
    "crmNote" TEXT,
    "dataSource" TEXT,
    "possessionTime" TEXT,
    "description" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skipped_rows" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "rawRow" JSONB NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "skipped_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_imports" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "status" "PendingImportStatus" NOT NULL DEFAULT 'PENDING',
    "records" JSONB NOT NULL,
    "skipped" JSONB NOT NULL,
    "failed" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "committedImportId" TEXT,

    CONSTRAINT "pending_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_importId_idx" ON "leads"("importId");

-- CreateIndex
CREATE INDEX "leads_email_idx" ON "leads"("email");

-- CreateIndex
CREATE INDEX "skipped_rows_importId_idx" ON "skipped_rows"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "pending_imports_committedImportId_key" ON "pending_imports"("committedImportId");

-- CreateIndex
CREATE INDEX "pending_imports_status_idx" ON "pending_imports"("status");

-- CreateIndex
CREATE INDEX "pending_imports_expiresAt_idx" ON "pending_imports"("expiresAt");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_importId_fkey" FOREIGN KEY ("importId") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skipped_rows" ADD CONSTRAINT "skipped_rows_importId_fkey" FOREIGN KEY ("importId") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_imports" ADD CONSTRAINT "pending_imports_committedImportId_fkey" FOREIGN KEY ("committedImportId") REFERENCES "imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
