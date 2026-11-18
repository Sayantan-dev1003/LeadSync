import prisma from '../lib/prisma';
import { sanitizeLogMessage } from '../lib/sanitizer';

export interface CleanupResult {
  expiredMarked: number;
  piiPurged: number;
  deletedOldImports: number;
}

/**
 * Service responsible for pending import data retention and lifecycle cleanup.
 *
 * Retention Policy:
 * 1. Staged Data (PendingImport):
 *    - Default TTL: 24 hours from creation (`expiresAt = createdAt + 24h`).
 *    - On Rejection: Immediate purge of `records`, `skipped`, and `failed` JSON payloads.
 *    - On Approval/Commit: Immediate purge of `records`, `skipped`, and `failed` JSON payloads
 *      (leads and skipped rows are safely persisted in permanent CRM tables).
 * 2. Expired Imports:
 *    - Pending imports past `expiresAt` cannot be approved.
 *    - Cleanup marks them as `EXPIRED` and purges all staged JSON data (`records`, `skipped`, `failed`).
 * 3. Audit Records:
 *    - Metadata (id, filename, totalRows, timestamps, committedImportId) is retained for auditability.
 *    - Obsolete expired or rejected pending records older than 30 days can be permanently deleted.
 *    - Permanent CRM records (`imports`, `leads`, `skipped_rows`) are NEVER deleted by this cleanup.
 */
export async function cleanupExpiredPendingImports(
  hardDeleteDaysThreshold: number = 30
): Promise<CleanupResult> {
  const now = new Date();
  const deleteThreshold = new Date(Date.now() - hardDeleteDaysThreshold * 24 * 60 * 60 * 1000);

  let expiredMarked = 0;
  let piiPurged = 0;
  let deletedOldImports = 0;

  try {
    // 1. Mark overdue PENDING imports as EXPIRED and purge their staged PII
    const expireResult = await prisma.pendingImport.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: now },
      },
      data: {
        status: 'EXPIRED',
        records: [],
        skipped: [],
        failed: [],
      },
    });
    expiredMarked = expireResult.count;

    // 2. Ensure any existing EXPIRED or REJECTED imports have their PII purged
    const purgeResult = await prisma.pendingImport.updateMany({
      where: {
        status: { in: ['EXPIRED', 'REJECTED'] },
        OR: [
          { records: { not: [] } },
          { skipped: { not: [] } },
          { failed: { not: [] } },
        ],
      },
      data: {
        records: [],
        skipped: [],
        failed: [],
      },
    });
    piiPurged = purgeResult.count;

    // 3. Purge aged pending records past hardDeleteDaysThreshold (only REJECTED or EXPIRED)
    // NEVER touches COMMITTED/APPROVED or permanent CRM tables
    const deleteResult = await prisma.pendingImport.deleteMany({
      where: {
        status: { in: ['EXPIRED', 'REJECTED'] },
        createdAt: { lt: deleteThreshold },
      },
    });
    deletedOldImports = deleteResult.count;

    return { expiredMarked, piiPurged, deletedOldImports };
  } catch (err) {
    const safeMsg = sanitizeLogMessage(err instanceof Error ? err.message : 'Database cleanup error');
    console.error(`Pending import data retention cleanup failed: ${safeMsg}`);
    throw err;
  }
}
