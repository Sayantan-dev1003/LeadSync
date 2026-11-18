/**
 * Tests for the import orchestrator service.
 *
 * Mocks extractBatch to avoid any AI API calls.
 */

jest.mock('../services/aiExtractor.service', () => ({
  extractBatch: jest.fn(),
  withRetry: jest.fn((fn: () => Promise<unknown>, _maxAttempts?: number) => fn()),
}));

import { orchestrateImport } from '../services/importOrchestrator.service';
import { extractBatch, withRetry } from '../services/aiExtractor.service';
import type { RawRow, SSEEvent, CRMRecord, SkippedRow, FailedRow } from '../types';

const mockExtractBatch = extractBatch as jest.MockedFunction<typeof extractBatch>;
const mockWithRetry = withRetry as jest.MockedFunction<typeof withRetry>;

function makeRecord(email: string): CRMRecord {
  return {
    created_at: null,
    name: null,
    email,
    country_code: null,
    mobile_without_country_code: null,
    company: null,
    city: null,
    state: null,
    country: null,
    lead_owner: null,
    crm_status: null,
    crm_note: null,
    data_source: null,
    possession_time: null,
    description: null,
  };
}

function makeRawRows(count: number): RawRow[] {
  return Array.from({ length: count }, (_, i) => ({ Email: `user${i}@example.com` }));
}

beforeEach(() => {
  jest.resetAllMocks();
  // Default withRetry just calls fn()
  mockWithRetry.mockImplementation(async (fn) => fn());
});

// ---------------------------------------------------------------------------
// Basic orchestration
// ---------------------------------------------------------------------------
describe('orchestrateImport — basic flow', () => {
  it('aggregates records from all batches', async () => {
    const rows = makeRawRows(4);

    mockExtractBatch.mockResolvedValue({
      records: [makeRecord('a@example.com'), makeRecord('b@example.com')],
      skipped: [],
      failed: [],
    });

    const events: SSEEvent[] = [];
    const result = await orchestrateImport(rows, (e) => events.push(e), {
      batchSize: 2,
      concurrency: 1,
      maxRetries: 1,
    });

    expect(result.records).toHaveLength(4);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('emits a progress event per batch', async () => {
    const rows = makeRawRows(6);
    mockExtractBatch.mockResolvedValue({ records: [makeRecord('x@x.com'), makeRecord('y@y.com')], skipped: [], failed: [] });

    const events: SSEEvent[] = [];
    await orchestrateImport(rows, (e) => events.push(e), { batchSize: 2, concurrency: 1, maxRetries: 1 });

    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents).toHaveLength(3); // 6 rows / 2 per batch = 3 batches
  });

  it('reports skipped rows correctly', async () => {
    const rows = makeRawRows(2);
    const skippedRow: SkippedRow = { row: { Name: 'No Contact' }, reason: 'No email or mobile number found' };

    mockExtractBatch.mockResolvedValue({ records: [], skipped: [skippedRow], failed: [] });

    const result = await orchestrateImport(rows, () => {}, { batchSize: 2, concurrency: 1, maxRetries: 1 });

    expect(result.skipped).toHaveLength(1);
    expect(result.records).toHaveLength(0);
  });

  it('reports failed rows from AI validation errors', async () => {
    const rows = makeRawRows(2);
    const failedRow: FailedRow = { row: { Name: 'Bad' }, reason: 'Validation error: Row 0: bad structure' };

    mockExtractBatch.mockResolvedValue({ records: [], skipped: [], failed: [failedRow] });

    const result = await orchestrateImport(rows, () => {}, { batchSize: 2, concurrency: 1, maxRetries: 1 });

    expect(result.failed).toHaveLength(1);
    expect(result.records).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failed batches after retry exhaustion
// ---------------------------------------------------------------------------
describe('orchestrateImport — retry exhaustion', () => {
  it('marks all rows in a batch as failed when retries are exhausted', async () => {
    const rows = makeRawRows(3);

    // withRetry propagates the final error
    mockWithRetry.mockRejectedValue(new Error('AI extraction failed — eligible for retry'));

    const events: SSEEvent[] = [];
    const result = await orchestrateImport(rows, (e) => events.push(e), {
      batchSize: 3,
      concurrency: 1,
      maxRetries: 3,
    });

    // All 3 rows should be failed, none skipped, none records
    expect(result.failed).toHaveLength(3);
    expect(result.records).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);

    // The failed reason should indicate AI failure
    expect(result.failed[0].reason).toMatch(/AI extraction failed/i);
  });

  it('distinguishes failed rows from skipped rows in the result', async () => {
    const rows = makeRawRows(4);
    const skippedRow: SkippedRow = { row: { X: 'y' }, reason: 'No email or mobile number found' };

    // First batch succeeds with a mix
    mockWithRetry
      .mockResolvedValueOnce({ records: [makeRecord('ok@example.com')], skipped: [skippedRow], failed: [] })
      // Second batch fails completely
      .mockRejectedValueOnce(new Error('AI permanently failed'));

    const result = await orchestrateImport(rows, () => {}, {
      batchSize: 2,
      concurrency: 1,
      maxRetries: 1,
    });

    expect(result.records).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.failed).toHaveLength(2); // Both rows in failed batch
  });
});

// ---------------------------------------------------------------------------
// Progress events include failed rows
// ---------------------------------------------------------------------------
describe('orchestrateImport — SSE events include failed info', () => {
  it('progress events include batchFailed', async () => {
    const rows = makeRawRows(2);
    const failedRow: FailedRow = { row: { X: 'y' }, reason: 'Validation error' };

    mockExtractBatch.mockResolvedValue({ records: [], skipped: [], failed: [failedRow, failedRow] });

    const events: SSEEvent[] = [];
    await orchestrateImport(rows, (e) => events.push(e), { batchSize: 2, concurrency: 1, maxRetries: 1 });

    const progressEvent = events.find((e) => e.type === 'progress');
    expect(progressEvent).toBeDefined();
    expect(progressEvent?.type === 'progress' && progressEvent.batchFailed).toHaveLength(2);
  });
});
