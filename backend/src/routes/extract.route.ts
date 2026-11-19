import { Router, Request, Response } from 'express';
import multer from 'multer';
import { parseCSVBuffer } from '../services/csvParser.service';
import { orchestrateImport } from '../services/importOrchestrator.service';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth.middleware';
import { sanitizeLogMessage } from '../lib/sanitizer';
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
 *   complete  — all batches done and staged in PendingImport; contains pendingImportId
 *   error     — unrecoverable pipeline error; stream ends after this
 *
 * The stream always ends with either 'complete' or 'error', never silently.
 * DB persistence has NOT occurred yet: totalImported=0 in the complete event.
 */
router.post('/', requireAuth, upload.single('file'), async (req: Request, res: Response): Promise<void> => {
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

  let clientDisconnected = false;
  let isStreamFinished = false;

  // Track premature client disconnection on the outgoing response and underlying socket.
  // Note: req.on('close') fires when the request upload stream completes, which must NOT
  // be mistaken for client disconnection from the active SSE response.
  if (typeof res.on === 'function') {
    res.on('close', () => {
      if (!isStreamFinished && !res.writableEnded) {
        clientDisconnected = true;
      }
    });

    res.on('error', () => {
      clientDisconnected = true;
    });
  }

  if (res.socket && typeof res.socket.on === 'function') {
    res.socket.on('close', () => {
      if (!isStreamFinished && !res.writableEnded) {
        clientDisconnected = true;
      }
    });
  }

  let terminalEventSent = false;

  const canWriteToStream = (): boolean => {
    return !clientDisconnected && !isStreamFinished && !res.writableEnded && res.writable;
  };

  const sendEvent = (event: SSEEvent): boolean => {
    if (!canWriteToStream()) return false;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      // Flush if available
      if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
        (res as unknown as { flush: () => void }).flush();
      }
      return true;
    } catch {
      clientDisconnected = true;
      return false;
    }
  };

  /**
   * Send a terminal event exactly once. Prevents double-firing 'complete'
   * and 'error' if an error is thrown after the complete event was sent.
   */
  const sendTerminalEvent = (event: SSEEvent): boolean => {
    if (terminalEventSent || !canWriteToStream()) return false;
    terminalEventSent = true;
    return sendEvent(event);
  };

  const filename = req.file.originalname;
  const allRecords: CRMRecord[] = [];
  const allSkipped: SkippedRow[] = [];
  const allFailed: FailedRow[] = [];

  try {
    // 1. Parse CSV
    const { rows, headers, warnings } = parseCSVBuffer(req.file.buffer);

    if (warnings.length > 0) {
      console.info('Parse warnings for file upload');
    }

    if (rows.length === 0) {
      sendTerminalEvent({ type: 'error', message: 'CSV file has no data rows to process' });
      return;
    }

    // 2. Run AI extraction with streaming progress
    const correlationId = (req.headers['x-correlation-id'] ||
      req.headers['x-request-id'] ||
      `corr_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`) as string;

    const { records, skipped, failed, aiUsage } = await orchestrateImport(
      rows,
      (event) => {
        if (!canWriteToStream()) return;
        if (event.type === 'progress') {
          allRecords.push(...event.batchRecords);
          allSkipped.push(...event.batchSkipped);
          allFailed.push(...event.batchFailed);
        }
        sendEvent(event);
      },
      { headers, filename, correlationId, userId: req.user?.id, user: req.user }
    );

    if (!canWriteToStream()) {
      return;
    }

    // 3. Stage in temporary server storage (PendingImport) — do NOT write to final CRM tables
    const ttlHours = parseInt(process.env.PENDING_IMPORT_TTL_HOURS || '24', 10);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    let pendingImportId: string | undefined;

    try {
      const pendingImport = await prisma.pendingImport.create({
        data: {
          userId: req.user?.id || null,
          filename,
          totalRows: rows.length,
          status: 'PENDING',
          records: records as any,
          skipped: skipped as any,
          failed: failed as any,
          aiUsage: aiUsage as any,
          expiresAt,
        },
      });
      pendingImportId = pendingImport.id;
    } catch (dbErr) {
      const safeDbErr = sanitizeLogMessage(dbErr instanceof Error ? dbErr.message.split('\n')[0] : 'Database error');
      console.error(`Failed to stage pending import: ${safeDbErr}`);
      sendTerminalEvent({
        type: 'error',
        message: 'Failed to stage extracted leads for review. Please try again.',
      });
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
      aiUsage,
    });
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message.split('\n')[0] : 'An unexpected error occurred';
    const safeMessage = sanitizeLogMessage(rawMessage);
    console.error('Extract pipeline error:', safeMessage);
    sendTerminalEvent({ type: 'error', message: safeMessage });
  } finally {
    isStreamFinished = true;
    if (!res.writableEnded && res.writable && !clientDisconnected) {
      try {
        res.end();
      } catch {}
    }
  }
});

export default router;
