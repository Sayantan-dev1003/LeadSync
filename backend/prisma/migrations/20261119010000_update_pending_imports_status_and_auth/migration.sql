-- AlterEnum
ALTER TYPE "PendingImportStatus" ADD VALUE IF NOT EXISTS 'APPROVED';

-- AlterTable
ALTER TABLE "imports" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- AlterTable
ALTER TABLE "pending_imports" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "imports_userId_idx" ON "imports"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pending_imports_userId_idx" ON "pending_imports"("userId");
