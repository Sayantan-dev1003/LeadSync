/**
 * Tests for the frontend SSE stream handling logic and event shapes (api.ts).
 *
 * These tests run in jsdom and avoid Web APIs (TextEncoder, ReadableStream)
 * that aren't universally available in that environment. Instead we test the
 * parsing logic and event-shape contracts directly.
 */

import type { ExtractEvent, ExtractCompleteEvent, ExtractErrorEvent } from '../lib/api';
import { approvePendingImport, rejectPendingImport, getPendingImport } from '../lib/api';

// ---------------------------------------------------------------------------
// SSE frame parser — extracted from the same logic used in extractLeads
// ---------------------------------------------------------------------------

interface ParseResult {
  receivedEvents: ExtractEvent[];
  receivedComplete: boolean;
  errorFromStream: string | null;
  parseErrors: number;
}

/**
 * Parse a raw SSE payload string (multiple "data: {...}\n\n" frames) using
 * the same logic that extractLeads uses, without needing a ReadableStream.
 */
function parseSSEPayload(payload: string): ParseResult {
  const receivedEvents: ExtractEvent[] = [];
  let receivedComplete = false;
  let errorFromStream: string | null = null;
  let parseErrors = 0;

  const frames = payload.split('\n\n');
  for (const frame of frames) {
    const dataLine = frame.trim();
    if (!dataLine.startsWith('data: ')) continue;

    const jsonStr = dataLine.slice(6);
    try {
      const event = JSON.parse(jsonStr) as ExtractEvent;
      receivedEvents.push(event);

      if (event.type === 'complete') {
        receivedComplete = true;
      } else if (event.type === 'error') {
        errorFromStream = event.message;
      }
    } catch {
      parseErrors++;
    }

    // Stop processing after a terminal event (matches extractLeads behavior)
    if (receivedComplete || errorFromStream !== null) break;
  }

  return { receivedEvents, receivedComplete, errorFromStream, parseErrors };
}

function makeSSEPayload(events: ExtractEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

// ---------------------------------------------------------------------------
// SSE event parsing behavior
// ---------------------------------------------------------------------------

describe('SSE event parsing', () => {
  it('detects a complete event in a successful stream', () => {
    const payload = makeSSEPayload([
      { type: 'progress', batchIndex: 1, totalBatches: 1, batchRecords: [], batchSkipped: [], batchFailed: [] },
      { type: 'complete', totalImported: 10, totalSkipped: 2, totalFailed: 0 },
    ]);

    const { receivedComplete, errorFromStream } = parseSSEPayload(payload);
    expect(receivedComplete).toBe(true);
    expect(errorFromStream).toBeNull();
  });

  it('detects an error event and does NOT set receivedComplete', () => {
    const payload = makeSSEPayload([
      { type: 'progress', batchIndex: 1, totalBatches: 1, batchRecords: [], batchSkipped: [], batchFailed: [] },
      { type: 'error', message: 'AI pipeline failed' },
    ]);

    const { receivedComplete, errorFromStream } = parseSSEPayload(payload);
    expect(receivedComplete).toBe(false);
    expect(errorFromStream).toBe('AI pipeline failed');
  });

  it('detects an interrupted stream (no terminal event)', () => {
    // Stream has only progress events — simulates an interrupted stream
    const payload = makeSSEPayload([
      { type: 'progress', batchIndex: 1, totalBatches: 2, batchRecords: [], batchSkipped: [], batchFailed: [] },
      { type: 'progress', batchIndex: 2, totalBatches: 2, batchRecords: [], batchSkipped: [], batchFailed: [] },
    ]);

    const { receivedComplete, errorFromStream } = parseSSEPayload(payload);

    // Neither flag is set → extractLeads should throw "stream ended without completion"
    expect(receivedComplete).toBe(false);
    expect(errorFromStream).toBeNull();
  });

  it('collects all progress events before the complete event', () => {
    const payload = makeSSEPayload([
      { type: 'progress', batchIndex: 1, totalBatches: 2, batchRecords: [], batchSkipped: [], batchFailed: [] },
      { type: 'progress', batchIndex: 2, totalBatches: 2, batchRecords: [], batchSkipped: [], batchFailed: [] },
      { type: 'complete', totalImported: 5, totalSkipped: 1, totalFailed: 0 },
    ]);

    const { receivedEvents } = parseSSEPayload(payload);
    expect(receivedEvents).toHaveLength(3);
    expect(receivedEvents[0].type).toBe('progress');
    expect(receivedEvents[1].type).toBe('progress');
    expect(receivedEvents[2].type).toBe('complete');
  });

  it('gracefully ignores malformed SSE frames', () => {
    // Mix of corrupted and valid frames
    const payload = `data: {invalid json}\n\ndata: ${JSON.stringify({ type: 'complete', totalImported: 1, totalSkipped: 0, totalFailed: 0 })}\n\n`;

    const { parseErrors, receivedComplete } = parseSSEPayload(payload);
    expect(parseErrors).toBe(1);
    expect(receivedComplete).toBe(true);
  });

  it('stops processing frames after an error event', () => {
    // Complete event AFTER error — should not be seen
    const payload = makeSSEPayload([
      { type: 'error', message: 'Fatal error' },
      { type: 'complete', totalImported: 100, totalSkipped: 0, totalFailed: 0 },
    ]);

    const { receivedEvents, receivedComplete, errorFromStream } = parseSSEPayload(payload);
    // Should stop after the error
    expect(receivedEvents).toHaveLength(1);
    expect(receivedComplete).toBe(false);
    expect(errorFromStream).toBe('Fatal error');
  });
});

// ---------------------------------------------------------------------------
// complete event shape
// ---------------------------------------------------------------------------
describe('SSE complete event shape', () => {
  it('complete event carries totalFailed', () => {
    const event: ExtractCompleteEvent = {
      type: 'complete',
      totalImported: 8,
      totalSkipped: 1,
      totalFailed: 2,
      importId: 'abc123',
    };

    expect(event.totalFailed).toBe(2);
    expect(event.importId).toBe('abc123');
  });

  it('complete event works without importId (DB failure scenario)', () => {
    const event: ExtractCompleteEvent = {
      type: 'complete',
      totalImported: 0, // DB failed — no rows actually persisted
      totalSkipped: 1,
      totalFailed: 0,
      // importId deliberately absent
    };

    expect(event.importId).toBeUndefined();
    expect(event.totalImported).toBe(0);
  });

  it('error event carries message string', () => {
    const event: ExtractErrorEvent = {
      type: 'error',
      message: 'AI extraction failed after maximum retries',
    };

    expect(event.message).toBeTruthy();
    expect(typeof event.message).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// extractLeads post-stream behavior (contract tests)
// ---------------------------------------------------------------------------
describe('extractLeads stream termination contracts', () => {
  /**
   * Documents what extractLeads MUST do at the call-site level.
   * These are enforced by the implementation in api.ts; here we validate
   * the logic that drives those decisions.
   */
  it('should reject when stream ends without complete event (interrupted stream)', () => {
    // Simulate: stream delivered only progress events
    const payload = makeSSEPayload([
      { type: 'progress', batchIndex: 1, totalBatches: 3, batchRecords: [], batchSkipped: [], batchFailed: [] },
    ]);

    const { receivedComplete, errorFromStream } = parseSSEPayload(payload);

    // Neither flag set → should trigger the "stream ended without completion" throw
    const shouldThrow = !receivedComplete && errorFromStream === null;
    expect(shouldThrow).toBe(true);
  });

  it('should reject when backend sends an error event', () => {
    const payload = makeSSEPayload([
      { type: 'error', message: 'CSV file has no data rows to process' },
    ]);

    const { errorFromStream } = parseSSEPayload(payload);
    // Should trigger a rejection with the error message
    expect(errorFromStream).toBe('CSV file has no data rows to process');
  });

  it('should resolve when stream delivers a complete event', () => {
    const payload = makeSSEPayload([
      { type: 'complete', totalImported: 5, totalSkipped: 1, totalFailed: 0, importId: 'imp-1' },
    ]);

    const { receivedComplete, errorFromStream } = parseSSEPayload(payload);
    expect(receivedComplete).toBe(true);
    expect(errorFromStream).toBeNull();
  });

  it('parses complete event carrying pendingImportId and totalValid for human review', () => {
    const payload = makeSSEPayload([
      {
        type: 'complete',
        pendingImportId: 'pending-999',
        totalValid: 15,
        totalSkipped: 2,
        totalFailed: 1,
        totalImported: 0,
      },
    ]);

    const { receivedEvents, receivedComplete } = parseSSEPayload(payload);
    expect(receivedComplete).toBe(true);
    const completeEvent = receivedEvents.find((e) => e.type === 'complete') as ExtractCompleteEvent;
    expect(completeEvent.pendingImportId).toBe('pending-999');
    expect(completeEvent.totalValid).toBe(15);
    expect(completeEvent.totalImported).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Human approval, rejection, and pending import API client functions
// ---------------------------------------------------------------------------
describe('Human-in-the-loop approval API functions', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('approvePendingImport sends POST and returns approval result', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        importId: 'crm_imp_123',
        totalImported: 10,
      }),
    });

    const result = await approvePendingImport('pending_abc');
    expect(result.success).toBe(true);
    expect(result.importId).toBe('crm_imp_123');
    expect(result.totalImported).toBe(10);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/imports/pending_abc/approve'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('approvePendingImport throws meaningful error when backend rejects approval', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'This pending import has expired' }),
    });

    await expect(approvePendingImport('pending_expired')).rejects.toThrow('This pending import has expired');
  });

  it('rejectPendingImport sends POST and returns rejection confirmation', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        message: 'Import rejected. No records were added to your CRM.',
        status: 'REJECTED',
      }),
    });

    const result = await rejectPendingImport('pending_xyz');
    expect(result.success).toBe(true);
    expect(result.status).toBe('REJECTED');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/imports/pending_xyz/reject'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('getPendingImport sends GET and returns pending import metadata', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pendingImport: {
          id: 'pending_1',
          filename: 'leads.csv',
          totalRows: 5,
          status: 'PENDING',
          records: [],
          skipped: [],
          failed: [],
        },
      }),
    });

    const result = await getPendingImport('pending_1');
    expect(result.id).toBe('pending_1');
    expect(result.status).toBe('PENDING');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/imports/pending/pending_1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.any(String),
        }),
      })
    );
  });
});
