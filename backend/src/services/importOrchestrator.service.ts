import pLimit from 'p-limit';
import { chunkArray } from './csvParser.service';
import { extractBatch, withRetry } from './aiExtractor.service';
import { planMappingsWithTools, type ValidatedMappingPlan } from './geminiToolOrchestrator.service';
import { ImportUsageTracker } from './importUsageTracker';
import type { CRMRecord, FailedRow, RawRow, SkippedRow, SSEEvent } from '../types';
import type { ImportAiUsageSummary } from '../types/observability';
import { sanitizeLogMessage } from '../lib/sanitizer';

import type { AuthUser } from '../middleware/auth.middleware';

export interface OrchestratorOptions {
  batchSize?: number;
  concurrency?: number;
  maxRetries?: number;
  filename?: string;
  importId?: string;
  headers?: string[];
  skipToolMapping?: boolean;
  correlationId?: string;
  userId?: string;
  user?: AuthUser;
  usageTracker?: ImportUsageTracker;
}

export type SSECallback = (event: SSEEvent) => void;

/**
 * Orchestrates the full import pipeline:
 * 1. Executes Stage A: Genuine Gemini tool-calling mapping planning for distinct headers
 * 2. Chunks rows into batches
 * 3. Processes batches concurrently with rate limiting and validated mapping context
 * 4. Retries failed batches with exponential backoff
 * 5. Streams progress events via callback
 * 6. Returns aggregated results including AI token usage, costs, latency & function-calling metrics
 *
 * Failed rows (AI/validation errors) are tracked separately from skipped rows
 * (deliberate skip because no contact info). This distinction is preserved in
 * the returned result and SSE events.
 */
export async function orchestrateImport(
  rows: RawRow[],
  onEvent: SSECallback,
  options: OrchestratorOptions = {}
): Promise<{
  records: CRMRecord[];
  skipped: SkippedRow[];
  failed: FailedRow[];
  mappingPlan?: ValidatedMappingPlan | null;
  aiUsage?: ImportAiUsageSummary;
}> {
  const batchSize = options.batchSize ?? parseInt(process.env.BATCH_SIZE || '20', 10);
  const concurrency = options.concurrency ?? parseInt(process.env.BATCH_CONCURRENCY || '3', 10);
  const maxRetries = options.maxRetries ?? parseInt(process.env.BATCH_MAX_RETRIES || '3', 10);

  // Initialize per-import AI usage tracker to aggregate metrics across all orchestration steps
  const effectiveImportId =
    options.importId ||
    options.correlationId ||
    `imp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const tracker =
    options.usageTracker ??
    new ImportUsageTracker({
      importId: effectiveImportId,
      correlationId: options.correlationId,
    });

  // ---------------------------------------------------------------------------
  // Stage A: Tool-orchestrated mapping planning (once per import)
  // ---------------------------------------------------------------------------
  const headers = options.headers ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
  let validatedMappingPlan: ValidatedMappingPlan | null = null;

  if (headers.length > 0 && !options.skipToolMapping) {
    try {
      const { plan, fallbackOccurred } = await planMappingsWithTools(headers, {
        correlationId: options.correlationId,
        importId: effectiveImportId,
        userId: options.userId,
        user: options.user,
        usageTracker: tracker,
      });
      if (plan && !fallbackOccurred) {
        validatedMappingPlan = plan;
      }
    } catch (toolErr) {
      const safeMessage = sanitizeLogMessage(
        toolErr instanceof Error ? toolErr.message : 'Unknown tool error'
      );
      console.warn(`[ImportOrchestrator] Tool mapping failed (${safeMessage}). Proceeding with heuristic extraction.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Stage B: Concurrent batch extraction using validatedMappingPlan
  // ---------------------------------------------------------------------------
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
          const result = await withRetry(
            () => extractBatch(batch, validatedMappingPlan, tracker),
            maxRetries
          );
          batchRecords = result.records;
          batchSkipped = result.skipped;
          batchFailed = result.failed;
        } catch (err) {
          // All retries exhausted — classify all rows in the batch as failed.
          // Log only diagnostic context with sanitized error message, never row contents or PII.
          const rawMessage = err instanceof Error ? err.message : 'Unknown error';
          const safeMessage = sanitizeLogMessage(rawMessage);
          console.error(
            `Batch ${batchIndex + 1} (${batch.length} rows) permanently failed after ${maxRetries} retries: ${safeMessage}`
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

  const aiUsage = tracker.finalize();

  return {
    records: allRecords,
    skipped: allSkipped,
    failed: allFailed,
    mappingPlan: validatedMappingPlan,
    aiUsage,
  };
}
