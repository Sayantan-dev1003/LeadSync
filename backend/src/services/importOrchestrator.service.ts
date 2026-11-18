import pLimit from 'p-limit';
import { chunkArray } from './csvParser.service';
import { extractBatch, withRetry } from './aiExtractor.service';
import type { CRMRecord, FailedRow, RawRow, SkippedRow, SSEEvent } from '../types';

export interface OrchestratorOptions {
  batchSize?: number;
  concurrency?: number;
  maxRetries?: number;
  filename?: string;
  importId?: string;
}

export type SSECallback = (event: SSEEvent) => void;

/**
 * Orchestrates the full import pipeline:
 * 1. Chunks rows into batches
 * 2. Processes batches concurrently with rate limiting
 * 3. Retries failed batches with exponential backoff
 * 4. Streams progress events via callback
 * 5. Returns aggregated results
 *
 * Failed rows (AI/validation errors) are tracked separately from skipped rows
 * (deliberate skip because no contact info). This distinction is preserved in
 * the returned result and SSE events.
 */
export async function orchestrateImport(
  rows: RawRow[],
  onEvent: SSECallback,
  options: OrchestratorOptions = {}
): Promise<{ records: CRMRecord[]; skipped: SkippedRow[]; failed: FailedRow[] }> {
  const batchSize = options.batchSize ?? parseInt(process.env.BATCH_SIZE || '20', 10);
  const concurrency = options.concurrency ?? parseInt(process.env.BATCH_CONCURRENCY || '3', 10);
  const maxRetries = options.maxRetries ?? parseInt(process.env.BATCH_MAX_RETRIES || '3', 10);

  const batches = chunkArray(rows, batchSize);
  const totalBatches = batches.length;

  const allRecords: CRMRecord[] = [];
  const allSkipped: SkippedRow[] = [];
  const allFailed: FailedRow[] = [];

  const limit = pLimit(concurrency);

  const batchResults = await Promise.all(
    batches.map((batch, batchIndex) =>
      limit(async () => {
        let batchRecords: CRMRecord[] = [];
        let batchSkipped: SkippedRow[] = [];
        let batchFailed: FailedRow[] = [];

        try {
          const result = await withRetry(() => extractBatch(batch), maxRetries);
          batchRecords = result.records;
          batchSkipped = result.skipped;
          batchFailed = result.failed;
        } catch (err) {
          // All retries exhausted — classify all rows in the batch as failed.
          // Log only the error message, not the full stack or any row data.
          const errMessage = err instanceof Error ? err.message : 'Unknown error';
          console.error(
            `Batch ${batchIndex + 1} permanently failed after ${maxRetries} retries: ${errMessage}`
          );
          batchFailed = batch.map((row) => ({
            row,
            reason: 'AI extraction failed after maximum retries',
          }));
        }

        // Stream progress event (includes failed rows so the frontend can track them)
        onEvent({
          type: 'progress',
          batchIndex: batchIndex + 1,
          totalBatches,
          batchRecords,
          batchSkipped,
          batchFailed,
        });

        return { batchRecords, batchSkipped, batchFailed };
      })
    )
  );

  batchResults.forEach(({ batchRecords, batchSkipped, batchFailed }) => {
    allRecords.push(...batchRecords);
    allSkipped.push(...batchSkipped);
    allFailed.push(...batchFailed);
  });

  return { records: allRecords, skipped: allSkipped, failed: allFailed };
}
