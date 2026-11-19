import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { validateCRMRecord } from '../services/zodSchemas.service';
import { shouldSkipRow } from '../services/validators.service';
import {
  requireAuth,
  requireOwner,
  isAuthorizedForPendingImport,
} from '../middleware/auth.middleware';
import { sanitizeLogMessage } from '../lib/sanitizer';
import { cleanupExpiredPendingImports } from '../services/retention.service';
import type { CRMRecord, SkippedRow, FailedRow } from '../types';

const router = Router();

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.trim().length > 0 && id.length <= 128;
}

/**
 * GET /api/imports/pending/:pendingImportId
 * Returns the staged records and metadata for a pending import awaiting human review.
 * Protected: requires authentication and authorization to access the pending import.
 */
router.get('/pending/:pendingImportId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { pendingImportId } = req.params;

  if (!isValidId(pendingImportId)) {
    res.status(400).json({ error: 'Invalid pending import ID' });
    return;
  }

  try {
    const pending = await prisma.pendingImport.findUnique({
      where: { id: pendingImportId },
    });

    if (!pending) {
      res.status(404).json({ error: 'Pending import not found' });
      return;
    }

    // Access authorization check
    if (req.user && !isAuthorizedForPendingImport(req.user, pending)) {
      res.status(403).json({ error: 'You are not authorized to view this pending import' });
      return;
    }

    // Check expiration
    const isExpired = pending.status === 'EXPIRED' || new Date() > new Date(pending.expiresAt);
    let currentStatus = pending.status;

    if (isExpired && pending.status === 'PENDING') {
      currentStatus = 'EXPIRED';
      await prisma.pendingImport.updateMany({
        where: { id: pendingImportId, status: 'PENDING' },
        data: {
          status: 'EXPIRED',
          records: [],
          skipped: [],
          failed: [],
        },
      });
    }

    const records = Array.isArray(pending.records) ? (pending.records as unknown as CRMRecord[]) : [];
    const skipped = Array.isArray(pending.skipped) ? (pending.skipped as unknown as SkippedRow[]) : [];
    const failed = Array.isArray(pending.failed) ? (pending.failed as unknown as FailedRow[]) : [];

    res.json({
      pendingImport: {
        id: pending.id,
        userId: pending.userId,
        filename: pending.filename,
        totalRows: pending.totalRows,
        status: currentStatus,
        totalValid: records.length,
        totalSkipped: skipped.length,
        totalFailed: failed.length,
        createdAt: pending.createdAt,
        expiresAt: pending.expiresAt,
        committedImportId: pending.committedImportId,
        records,
        skipped,
        failed,
      },
    });
  } catch (err) {
    const safeMsg = sanitizeLogMessage(err instanceof Error ? err.message : 'Database error');
    console.error(`Failed to fetch pending import ${pendingImportId}: ${safeMsg}`);
    res.status(500).json({ error: 'Failed to fetch pending import' });
  }
});

/**
 * POST /api/imports/:pendingImportId/approve
 * Explicit human approval:
 * 1. Validates authentication & authorization (cannot approve someone else's import).
 * 2. Checks state: only PENDING imports can transition to approved.
 * 3. Server-side revalidates all records before persistence.
 * 4. Atomically:
 *    - Acquires lock via conditional atomic update (status: PENDING -> APPROVED).
 *    - Creates permanent Import, Lead, and SkippedRow records in the CRM database.
 *    - Updates PendingImport with committedImportId and purges staged PII.
 * 5. Handles concurrent requests race-safely and provides idempotent response for duplicate approvals.
 * 6. Entire operation rolls back if DB persistence fails.
 */
router.post('/:pendingImportId/approve', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { pendingImportId } = req.params;

  if (!isValidId(pendingImportId)) {
    res.status(400).json({ error: 'Invalid pending import ID' });
    return;
  }

  try {
    // 1. Initial read and validation checks
    const initialPending = await prisma.pendingImport.findUnique({
      where: { id: pendingImportId },
    });

    if (!initialPending) {
      res.status(404).json({ error: 'Pending import not found' });
      return;
    }

    // Authorization check
    if (req.user && !isAuthorizedForPendingImport(req.user, initialPending)) {
      res.status(403).json({ error: 'You are not authorized to approve this pending import' });
      return;
    }

    // Idempotent retry: already approved/committed
    if (
      (initialPending.status === 'APPROVED' || initialPending.status === 'COMMITTED') &&
      initialPending.committedImportId
    ) {
      const records = Array.isArray(initialPending.records) ? initialPending.records : [];
      res.json({
        success: true,
        importId: initialPending.committedImportId,
        totalImported: initialPending.totalRows,
        message: 'Import already approved and committed',
      });
      return;
    }

    // Rejection check: rejected imports must never be committed
    if (initialPending.status === 'REJECTED') {
      res.status(400).json({ error: 'This pending import was rejected and cannot be approved' });
      return;
    }

    // Expiration check: expired imports must never be committed
    const isExpired = initialPending.status === 'EXPIRED' || new Date() > new Date(initialPending.expiresAt);
    if (isExpired) {
      if (initialPending.status !== 'EXPIRED') {
        await prisma.pendingImport.updateMany({
          where: { id: pendingImportId, status: 'PENDING' },
          data: {
            status: 'EXPIRED',
            records: [],
            skipped: [],
            failed: [],
          },
        });
      }
      res.status(400).json({ error: 'This pending import has expired and cannot be approved' });
      return;
    }

    if (initialPending.status !== 'PENDING') {
      res.status(400).json({
        error: `Pending import is not eligible for approval (status: ${initialPending.status})`,
      });
      return;
    }

    // 2. Server-side revalidation of records before persistence using CRMRecordSchema
    const rawRecords = Array.isArray(initialPending.records) ? (initialPending.records as unknown[]) : [];
    const revalidatedRecords: CRMRecord[] = [];

    for (let i = 0; i < rawRecords.length; i++) {
      const row = rawRecords[i];
      const parseResult = validateCRMRecord(row);
      if (!parseResult.success) {
        // Avoid exposing sensitive CRM values in validation error messages
        const sanitizedErrors = parseResult.error.errors
          .map((e) => `${e.path.join('.') || 'field'}: ${e.message}`)
          .join('; ');
        res.status(422).json({
          error: `Invalid pending data at record ${i + 1}: ${sanitizedErrors}`,
        });
        return;
      }

      const data = parseResult.data;
      if (shouldSkipRow(data.email, data.mobile_without_country_code)) {
        res.status(422).json({
          error: `Invalid pending data at record ${i + 1}: Record is missing both email and mobile contact info`,
        });
        return;
      }

      revalidatedRecords.push(data as CRMRecord);
    }

    const skipped = Array.isArray(initialPending.skipped) ? (initialPending.skipped as unknown as SkippedRow[]) : [];
    const failed = Array.isArray(initialPending.failed) ? (initialPending.failed as unknown as FailedRow[]) : [];

    // 3. Atomic transaction:
    // Only a PENDING import can be claimed.
    // Transition to APPROVED, persist leads, associate committedImportId, and purge staged PII.
    const result = await prisma.$transaction(
      async (tx) => {
        // Atomic status transition from PENDING to APPROVED to prevent concurrent race conditions
        const locked = await tx.pendingImport.updateMany({
          where: {
            id: pendingImportId,
            status: 'PENDING',
            expiresAt: { gt: new Date() },
          },
          data: {
            status: 'APPROVED',
          },
        });

        if (locked.count === 0) {
          // Another concurrent request committed or modified it
          const check = await tx.pendingImport.findUnique({ where: { id: pendingImportId } });
          if (
            (check?.status === 'APPROVED' || check?.status === 'COMMITTED') &&
            check.committedImportId
          ) {
            return {
              alreadyCommitted: true,
              importId: check.committedImportId,
              totalImported: revalidatedRecords.length,
            };
          }
          if (check?.status === 'REJECTED') {
            throw new Error('REJECTED_CONFLICT');
          }
          if (check?.status === 'EXPIRED') {
            throw new Error('EXPIRED_CONFLICT');
          }
          throw new Error('CONCURRENT_CONFLICT');
        }

        // Create permanent Import and Lead records
        const createdImport = await tx.import.create({
          data: {
            userId: initialPending.userId,
            filename: initialPending.filename,
            totalRows: initialPending.totalRows,
            totalImported: revalidatedRecords.length,
            totalSkipped: skipped.length + failed.length,
            leads: {
              create: revalidatedRecords.map((r) => ({
                createdAt: (() => {
                  if (!r.created_at) return null;
                  const d = new Date(r.created_at);
                  return isNaN(d.getTime()) ? null : d;
                })(),
                name: r.name,
                email: r.email,
                countryCode: r.country_code,
                mobileWithoutCountryCode: r.mobile_without_country_code,
                company: r.company,
                city: r.city,
                state: r.state,
                country: r.country,
                leadOwner: r.lead_owner,
                crmStatus: r.crm_status,
                crmNote: r.crm_note,
                dataSource: r.data_source,
                possessionTime: r.possession_time,
                description: r.description,
              })),
            },
            skippedRows: {
              create: [
                ...skipped.map((s) => ({
                  rawRow: s.row as any,
                  reason: s.reason,
                })),
                ...failed.map((f) => ({
                  rawRow: f.row as any,
                  reason: `[AI_FAILURE] ${f.reason}`,
                })),
              ],
            },
          },
        });

        // Associate committed import ID and PURGE staged PII to adhere to retention policy
        await tx.pendingImport.update({
          where: { id: pendingImportId },
          data: {
            committedImportId: createdImport.id,
            records: [], // Purge sensitive staged records
            skipped: [], // Purge sensitive raw row snippets
            failed: [],  // Purge sensitive raw row snippets
          },
        });

        return {
          alreadyCommitted: false,
          importId: createdImport.id,
          totalImported: revalidatedRecords.length,
        };
      },
      {
        timeout: 15000,
      }
    );

    res.json({
      success: true,
      importId: result.importId,
      totalImported: result.totalImported,
      totalSkipped: skipped.length,
      totalFailed: failed.length,
      message: result.alreadyCommitted ? 'Import already approved and committed' : undefined,
    });
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message === 'CONCURRENT_CONFLICT') {
        res.status(409).json({ error: 'Import is currently being processed by another request' });
        return;
      }
      if (err.message === 'REJECTED_CONFLICT') {
        res.status(400).json({ error: 'This pending import was rejected and cannot be approved' });
        return;
      }
      if (err.message === 'EXPIRED_CONFLICT') {
        res.status(400).json({ error: 'This pending import has expired and cannot be approved' });
        return;
      }
    }
    const safeError = sanitizeLogMessage(err instanceof Error ? err.message.split('\n')[0] : 'Database error');
    console.error(`Approval failed for pending import ${pendingImportId}: ${safeError}`);
    res.status(500).json({ error: 'Failed to commit approved import to database' });
  }
});

/**
 * POST /api/imports/:pendingImportId/reject
 * Explicit human rejection:
 * - Ensures zero final CRM leads or imports are created.
 * - Uses atomic conditional update (status must be PENDING) to prevent race conditions with approval.
 * - Mutually exclusive with approval.
 * - Immediately purges staged customer PII (records, skipped, failed).
 * - Idempotent against repeated rejection requests.
 */
router.post('/:pendingImportId/reject', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { pendingImportId } = req.params;

  if (!isValidId(pendingImportId)) {
    res.status(400).json({ error: 'Invalid pending import ID' });
    return;
  }

  try {
    const pending = await prisma.pendingImport.findUnique({
      where: { id: pendingImportId },
    });

    if (!pending) {
      res.status(404).json({ error: 'Pending import not found' });
      return;
    }

    // Authorization check
    if (req.user && !isAuthorizedForPendingImport(req.user, pending)) {
      res.status(403).json({ error: 'You are not authorized to reject this pending import' });
      return;
    }

    // Gracefully handle repeated rejection
    if (pending.status === 'REJECTED') {
      res.json({
        success: true,
        message: 'Pending import is already rejected',
        status: 'REJECTED',
      });
      return;
    }

    if (pending.status === 'APPROVED' || pending.status === 'COMMITTED') {
      res.status(400).json({ error: 'Cannot reject an import that has already been approved or committed' });
      return;
    }

    // Atomic conditional status transition from PENDING to REJECTED + PII purge
    const result = await prisma.pendingImport.updateMany({
      where: {
        id: pendingImportId,
        status: 'PENDING',
      },
      data: {
        status: 'REJECTED',
        records: [], // Purge staged leads
        skipped: [], // Purge raw rows containing PII
        failed: [],  // Purge raw rows containing PII
      },
    });

    if (result.count === 0) {
      // Concurrently updated by another request
      const current = await prisma.pendingImport.findUnique({ where: { id: pendingImportId } });
      if (current?.status === 'REJECTED') {
        res.json({
          success: true,
          message: 'Pending import is already rejected',
          status: 'REJECTED',
        });
        return;
      }
      if (current?.status === 'APPROVED' || current?.status === 'COMMITTED') {
        res.status(400).json({ error: 'Cannot reject an import that has already been approved' });
        return;
      }
      res.status(409).json({ error: 'Import is currently being processed by another request' });
      return;
    }

    res.json({
      success: true,
      message: 'Import rejected. No records were added to your CRM.',
      status: 'REJECTED',
    });
  } catch (err) {
    const safeError = sanitizeLogMessage(err instanceof Error ? err.message : 'Database error');
    console.error(`Failed to reject pending import ${pendingImportId}: ${safeError}`);
    res.status(500).json({ error: 'Failed to reject pending import' });
  }
});

/**
 * POST /api/imports/cleanup
 * Admin maintenance endpoint to trigger expired staged-import cleanup.
 */
router.post('/cleanup', requireOwner, async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await cleanupExpiredPendingImports();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: 'Cleanup execution failed' });
  }
});

/**
 * GET /api/imports
 * Returns a list of past import jobs for the "Manage Leads" history view.
 */
router.get('/', requireAuth, async (_req: Request, res: Response): Promise<void> => {
  try {
    const imports = await prisma.import.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        userId: true,
        filename: true,
        totalRows: true,
        totalImported: true,
        totalSkipped: true,
        createdAt: true,
      },
    });
    res.json({ imports });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch imports' });
  }
});

/**
 * GET /api/imports/:id
 * Returns metadata for a specific import job.
 */
router.get('/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'Invalid import ID' });
    return;
  }

  try {
    const importJob = await prisma.import.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        filename: true,
        totalRows: true,
        totalImported: true,
        totalSkipped: true,
        createdAt: true,
      },
    });

    if (!importJob) {
      res.status(404).json({ error: 'Import not found' });
      return;
    }

    res.json({ importJob });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch import job' });
  }
});

/**
 * GET /api/imports/:id/leads
 * Returns paginated leads for a specific import job.
 */
router.get('/:id/leads', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'Invalid import ID' });
    return;
  }

  const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '50', 10)));
  const search = ((req.query.search as string) || '').trim();

  try {
    const where = {
      importId: id,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
              { mobileWithoutCountryCode: { contains: search } },
            ],
          }
        : {}),
    };

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { importedAt: 'asc' },
      }),
      prisma.lead.count({ where }),
    ]);

    res.json({ leads, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

/**
 * GET /api/imports/:id/skipped
 * Returns paginated skipped rows for a specific import job.
 */
router.get('/:id/skipped', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'Invalid import ID' });
    return;
  }

  const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '50', 10)));

  try {
    const where = { importId: id };

    const [skippedRows, total] = await Promise.all([
      prisma.skippedRow.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.skippedRow.count({ where }),
    ]);

    res.json({ skippedRows, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch skipped rows' });
  }
});

export default router;
