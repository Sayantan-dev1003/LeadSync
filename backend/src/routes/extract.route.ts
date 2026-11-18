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

    // 3. Stage in temporary server storage (PendingImport) — do NOT write to final CRM tables
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour retention window
    let pendingImportId: string | undefined;

    try {
      const pendingImport = await prisma.pendingImport.create({
        data: {
          filename,
          totalRows: rows.length,
          status: 'PENDING',
          records: records as any,
          skipped: skipped as any,
          failed: failed as any,
          expiresAt,
        },
      });
      pendingImportId = pendingImport.id;
    } catch (dbErr) {
      const dbErrMessage = dbErr instanceof Error ? dbErr.message.split('\n')[0] : 'Database error';
      console.error(`Failed to stage pending import: ${dbErrMessage}`);
      sendTerminalEvent({
        type: 'error',
        message: 'Failed to stage extracted leads for review. Please try again.',
      });
      res.end();
      return;
    }

    // 4. Send completion event with pending import ID for human review
    sendTerminalEvent({
      type: 'complete',
      pendingImportId,
      totalValid: records.length,
      totalSkipped: skipped.length,
      totalFailed: failed.length,
      totalImported: 0,
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
