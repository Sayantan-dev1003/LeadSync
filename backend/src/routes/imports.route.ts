import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { validateAIRow } from '../services/zodSchemas.service';
import { shouldSkipRow } from '../services/validators.service';
import type { CRMRecord, SkippedRow, FailedRow } from '../types';

const router = Router();

/**
 * GET /api/imports/pending/:pendingImportId
 * Returns the staged records and metadata for a pending import awaiting human review.
 */
router.get('/pending/:pendingImportId', async (req: Request, res: Response): Promise<void> => {
  const { pendingImportId } = req.params;

  try {
    const pending = await prisma.pendingImport.findUnique({
      where: { id: pendingImportId },
    });

    if (!pending) {
      res.status(404).json({ error: 'Pending import not found' });
      return;
    }

    // Check expiration
    const isExpired = pending.status === 'EXPIRED' || new Date() > new Date(pending.expiresAt);
    let currentStatus = pending.status;

    if (isExpired && pending.status === 'PENDING') {
      currentStatus = 'EXPIRED';
      await prisma.pendingImport.update({
        where: { id: pendingImportId },
        data: { status: 'EXPIRED' },
      });
    }

    const records = Array.isArray(pending.records) ? (pending.records as unknown as CRMRecord[]) : [];
    const skipped = Array.isArray(pending.skipped) ? (pending.skipped as unknown as SkippedRow[]) : [];
    const failed = Array.isArray(pending.failed) ? (pending.failed as unknown as FailedRow[]) : [];

    res.json({
      pendingImport: {
        id: pending.id,
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
    const msg = err instanceof Error ? err.message : 'Database error';
    console.error(`Failed to fetch pending import ${pendingImportId}: ${msg}`);
    res.status(500).json({ error: 'Failed to fetch pending import' });
  }
});

/**
 * POST /api/imports/:pendingImportId/approve
 * Explicit human approval:
 * 1. Loads pending import from DB
 * 2. Ensures it is eligible for approval (not expired, rejected, or committed)
 * 3. Server-side revalidates all records
 * 4. Atomically persists leads, skipped rows, and import metadata
 * 5. Marks pending import committed and associates final import ID
 * 6. Guarantees idempotency against duplicate/concurrent submissions
 */
router.post('/:pendingImportId/approve', async (req: Request, res: Response): Promise<void> => {
  const { pendingImportId } = req.params;

  try {
    // 1. Initial read and validation checks
    const initialPending = await prisma.pendingImport.findUnique({
      where: { id: pendingImportId },
    });

    if (!initialPending) {
      res.status(404).json({ error: 'Pending import not found' });
      return;
    }

    // Idempotent retry: already committed
    if (initialPending.status === 'COMMITTED' && initialPending.committedImportId) {
      const records = Array.isArray(initialPending.records) ? initialPending.records : [];
      res.json({
        success: true,
        importId: initialPending.committedImportId,
        totalImported: records.length,
        message: 'Import already approved and committed',
      });
      return;
    }

    // Rejection check
    if (initialPending.status === 'REJECTED') {
      res.status(400).json({ error: 'This pending import was rejected and cannot be approved' });
      return;
    }

    // Expiration check
    if (initialPending.status === 'EXPIRED' || new Date() > new Date(initialPending.expiresAt)) {
      if (initialPending.status !== 'EXPIRED') {
        await prisma.pendingImport.update({
          where: { id: pendingImportId },
          data: { status: 'EXPIRED' },
        });
      }
      res.status(400).json({ error: 'This pending import has expired and cannot be approved' });
      return;
    }

    if (initialPending.status !== 'PENDING') {
      res.status(400).json({ error: `Pending import is not eligible for approval (status: ${initialPending.status})` });
      return;
    }

    // 2. Server-side revalidation of records before persistence
    const rawRecords = Array.isArray(initialPending.records) ? (initialPending.records as unknown[]) : [];
    const revalidatedRecords: CRMRecord[] = [];

    for (let i = 0; i < rawRecords.length; i++) {
      const row = rawRecords[i];
      const parseResult = validateAIRow(row);
      if (!parseResult.success) {
        res.status(422).json({
          error: `Invalid pending data at record ${i + 1}: ${parseResult.error.errors.map((e) => e.message).join('; ')}`,
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

      const { skip: _s, skipReason: _sr, ...crmRecord } = data;
      revalidatedRecords.push(crmRecord as CRMRecord);
    }

    const skipped = Array.isArray(initialPending.skipped) ? (initialPending.skipped as unknown as SkippedRow[]) : [];
    const failed = Array.isArray(initialPending.failed) ? (initialPending.failed as unknown as FailedRow[]) : [];

    // 3. Atomic transaction: lock pending record, create final import + leads, update status
    const result = await prisma.$transaction(async (tx) => {
      // Atomic status transition from PENDING to COMMITTED to prevent concurrent writes
      const locked = await tx.pendingImport.updateMany({
        where: {
          id: pendingImportId,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        data: {
          status: 'COMMITTED',
        },
      });

      if (locked.count === 0) {
        // Another concurrent request committed or modified it
        const check = await tx.pendingImport.findUnique({ where: { id: pendingImportId } });
        if (check?.status === 'COMMITTED' && check.committedImportId) {
          return {
            alreadyCommitted: true,
            importId: check.committedImportId,
            totalImported: revalidatedRecords.length,
          };
        }
        throw new Error('CONCURRENT_CONFLICT');
      }

      // Create permanent Import and Lead records
      const createdImport = await tx.import.create({
        data: {
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

      // Associate committed import ID with pending import
      await tx.pendingImport.update({
        where: { id: pendingImportId },
        data: {
          committedImportId: createdImport.id,
        },
      });

      return {
        alreadyCommitted: false,
        importId: createdImport.id,
        totalImported: revalidatedRecords.length,
      };
    });

    res.json({
      success: true,
      importId: result.importId,
      totalImported: result.totalImported,
      totalSkipped: skipped.length,
      totalFailed: failed.length,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'CONCURRENT_CONFLICT') {
      res.status(409).json({ error: 'Import is currently being processed by another request' });
      return;
    }
    const msg = err instanceof Error ? err.message.split('\n')[0] : 'Database error';
    console.error(`Approval failed for pending import ${pendingImportId}: ${msg}`);
    res.status(500).json({ error: 'Failed to commit approved import to database' });
  }
});

/**
 * POST /api/imports/:pendingImportId/reject
 * Explicit human rejection:
 * - Ensures zero final CRM leads or imports are created
 * - Marks status as REJECTED
 * - Prevents future approval
 * - Removes staged PII from storage according to retention policy
 * - Handles repeated rejection gracefully
 */
router.post('/:pendingImportId/reject', async (req: Request, res: Response): Promise<void> => {
  const { pendingImportId } = req.params;

  try {
    const pending = await prisma.pendingImport.findUnique({
      where: { id: pendingImportId },
    });

    if (!pending) {
      res.status(404).json({ error: 'Pending import not found' });
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

    if (pending.status === 'COMMITTED') {
      res.status(400).json({ error: 'Cannot reject an import that has already been committed' });
      return;
    }

    // Update status to REJECTED and purge staged PII
    await prisma.pendingImport.update({
      where: { id: pendingImportId },
      data: {
        status: 'REJECTED',
        records: [], // Clear staged records to eliminate unnecessary PII
      },
    });

    res.json({
      success: true,
      message: 'Import rejected. No records were added to your CRM.',
      status: 'REJECTED',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Database error';
    console.error(`Failed to reject pending import ${pendingImportId}: ${msg}`);
    res.status(500).json({ error: 'Failed to reject pending import' });
  }
});

/**
 * GET /api/imports
 * Returns a list of past import jobs for the "Manage Leads" history view.
 */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const imports = await prisma.import.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
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
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const importJob = await prisma.import.findUnique({
      where: { id },
      select: {
        id: true,
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
router.get('/:id/leads', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const page = parseInt(req.query.page as string || '1', 10);
  const limit = parseInt(req.query.limit as string || '50', 10);
  const search = (req.query.search as string || '').trim();

  try {
    const where = {
      importId: id,
      ...(search ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
          { mobileWithoutCountryCode: { contains: search } },
        ],
      } : {}),
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
router.get('/:id/skipped', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const page = parseInt(req.query.page as string || '1', 10);
  const limit = parseInt(req.query.limit as string || '50', 10);

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
