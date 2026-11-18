import { Router, Request, Response } from 'express';
import multer from 'multer';
import { parseCSVBuffer } from '../services/csvParser.service';
import { orchestrateImport } from '../services/importOrchestrator.service';
import prisma from '../lib/prisma';
import type { SSEEvent, CRMRecord, SkippedRow, FailedRow } from '../types';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'));
    }
  },
});

/**
 * POST /api/extract
 * Accepts a CSV file upload, parses it, runs AI field extraction in batches,
 * and streams results back via Server-Sent Events (SSE).
 *
 * Event types:
 *   progress  — batch processed; contains batchRecords, batchSkipped, batchFailed
 *   complete  — all batches done and DB write attempted; contains final counts and importId
 *   error     — unrecoverable pipeline error; stream ends after this
 *
 * The stream always ends with either 'complete' or 'error', never silently.
 * DB persistence failures cause totalImported=0 in the complete event rather
 * than falsely claiming success.
 */
router.post('/', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  // --- Set up SSE headers ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  let terminalEventSent = false;

  const sendEvent = (event: SSEEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // Flush if available (important for streaming)
    if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
      (res as unknown as { flush: () => void }).flush();
    }
  };

  /**
   * Send a terminal event exactly once. Prevents double-firing 'complete'
   * and 'error' if an error is thrown after the complete event was sent.
   */
  const sendTerminalEvent = (event: SSEEvent): void => {
    if (terminalEventSent) return;
    terminalEventSent = true;
    sendEvent(event);
  };

  const filename = req.file.originalname;
  const allRecords: CRMRecord[] = [];
  const allSkipped: SkippedRow[] = [];
  const allFailed: FailedRow[] = [];

  try {
    // 1. Parse CSV
    const { rows, warnings } = parseCSVBuffer(req.file.buffer);

    if (warnings.length > 0) {
      console.info('Parse warnings for file upload');
    }

    if (rows.length === 0) {
      sendTerminalEvent({ type: 'error', message: 'CSV file has no data rows to process' });
      res.end();
      return;
    }

    // 2. Run AI extraction with streaming progress
    const { records, skipped, failed } = await orchestrateImport(rows, (event) => {
      // Collect results as they stream
      if (event.type === 'progress') {
        allRecords.push(...event.batchRecords);
        allSkipped.push(...event.batchSkipped);
        allFailed.push(...event.batchFailed);
      }
      sendEvent(event);
    });

    // 3. Persist to database — count only actually persisted rows
    let importId: string | undefined;
    let actuallyImported = 0;

    if (records.length > 0 || skipped.length > 0 || failed.length > 0) {
      try {
        const dbImport = await prisma.import.create({
          data: {
            filename,
            totalRows: rows.length,
            totalImported: records.length, // Will be corrected below if DB partially fails
            totalSkipped: skipped.length,
            leads: {
              create: records.map((r) => ({
                // Validate the date once more before Prisma: only pass a Date if it parses cleanly
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
                  rawRow: s.row,
                  reason: s.reason,
                })),
                // Store failed rows in skippedRows table with a prefixed reason
                // so they are visible in the DB without changing the schema
                ...failed.map((f) => ({
                  rawRow: f.row,
                  reason: `[AI_FAILURE] ${f.reason}`,
                })),
              ],
            },
          },
          include: { _count: { select: { leads: true } } },
        });

        importId = dbImport.id;
        // Use actual DB lead count, not the in-memory count, in case of partial persistence
        actuallyImported = dbImport._count.leads;
      } catch (dbErr) {
        // DB persistence failed — log the error class only, not full stack or data
        const dbErrMessage = dbErr instanceof Error ? dbErr.message.split('\n')[0] : 'Database error';
        console.error(`Database persistence failed: ${dbErrMessage}`);
        // actuallyImported stays 0; importId stays undefined
        // Report this as 0 imported rather than falsely claiming success
      }
    }

    // 4. Send completion event with accurate counts
    sendTerminalEvent({
      type: 'complete',
      totalImported: actuallyImported,
      totalSkipped: skipped.length,
      totalFailed: failed.length,
      importId,
    });
  } catch (err: unknown) {
    // Top-level error — send a safe message without stack traces or data
    const message = err instanceof Error ? err.message.split('\n')[0] : 'An unexpected error occurred';
    console.error('Extract pipeline error:', err instanceof Error ? err.message : err);
    sendTerminalEvent({ type: 'error', message });
  } finally {
    res.end();
  }
});

export default router;
