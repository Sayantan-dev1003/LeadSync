import { performance } from 'perf_hooks';
import type {
  GeminiUsageMetadata,
  GeminiRequestUsageRecord,
  ImportAiUsageSummary,
  GeminiCallType,
} from '../types/observability';
import {
  calculateResponseCost,
  buildEstimatedCostSummary,
  normalizeModelId,
} from './geminiPricing.service';
import { auditLogger } from './auditLogger.service';

export interface TrackerInitOptions {
  importId: string;
  correlationId?: string;
  modelId?: string;
}

export interface RecordGeminiParams {
  callType: GeminiCallType;
  modelId?: string;
  latencyMs: number;
  response?: {
    usageMetadata?: GeminiUsageMetadata;
    [key: string]: unknown;
  };
  requestId?: string;
  error?: Error | unknown;
  status?: 'success' | 'failed';
}

/**
 * Production-quality, lightweight tracker for Gemini LLM token consumption,
 * estimated API costs, LLM latency, and function-call executions.
 *
 * Scoped per import to aggregate metrics across all orchestration steps.
 */
export class ImportUsageTracker {
  public readonly importId: string;
  public readonly correlationId?: string;
  public readonly defaultModelId: string;

  private inputTokens: number = 0;
  private outputTokens: number = 0;
  private totalTokens: number = 0;
  private thoughtsTokens: number = 0;
  private toolUsePromptTokens: number = 0;
  private cachedContentTokens: number = 0;

  private totalLatencyMs: number = 0;
  private maxLatencyMs: number = 0;

  private geminiRequestCount: number = 0;
  private successfulRequestCount: number = 0;
  private failedRequestCount: number = 0;
  private missingMetadataRequestCount: number = 0;

  private functionCallAttemptedCount: number = 0;
  private functionCallSuccessCount: number = 0;
  private functionCallFailedCount: number = 0;
  private functionCallsByTool: Record<string, { executed: number; successful: number; failed: number }> = {};

  private requestRecords: GeminiRequestUsageRecord[] = [];
  private processedRequestIds: Set<string> = new Set();

  private isFinalized: boolean = false;
  private finalizedSummary: ImportAiUsageSummary | null = null;

  constructor(options: TrackerInitOptions) {
    this.importId = options.importId;
    this.correlationId = options.correlationId;
    this.defaultModelId = normalizeModelId(
      options.modelId || process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    );
  }

  /**
   * Generates a unique request ID if not provided by the caller.
   */
  private generateRequestId(callType: string): string {
    return `req_${callType}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Records a Gemini API response (or failure).
   * Safe against duplicate events and missing metadata.
   */
  public recordGeminiResponse(params: RecordGeminiParams): GeminiRequestUsageRecord | null {
    try {
      const requestId = params.requestId || this.generateRequestId(params.callType);

      // Deduplication check: Never double-count duplicate calls
      if (this.processedRequestIds.has(requestId)) {
        return this.requestRecords.find((r) => r.requestId === requestId) || null;
      }
      this.processedRequestIds.add(requestId);

      const modelId = normalizeModelId(params.modelId || this.defaultModelId);
      const isFailed = params.status === 'failed' || !!params.error;
      const latencyMs = Math.max(0, Math.round(params.latencyMs));

      this.geminiRequestCount++;

      if (isFailed) {
        this.failedRequestCount++;
        const errorMessage = params.error instanceof Error ? params.error.message : 'Gemini API call failed';

        const record: GeminiRequestUsageRecord = {
          requestId,
          importId: this.importId,
          correlationId: this.correlationId,
          callType: params.callType,
          modelId,
          latencyMs,
          hasUsageMetadata: false,
          promptTokenCount: null,
          candidatesTokenCount: null,
          totalTokenCount: null,
          estimatedCostUsd: null,
          status: 'failed',
          errorMessage,
          timestamp: new Date().toISOString(),
        };

        this.requestRecords.push(record);

        auditLogger.logGeminiRequest({
          event: 'gemini_request_failed',
          importId: this.importId,
          correlationId: this.correlationId,
          modelId,
          requestId,
          callType: params.callType,
          latencyMs,
          status: 'failed',
          errorMessage,
        });

        return record;
      }

      this.successfulRequestCount++;
      this.totalLatencyMs += latencyMs;
      if (latencyMs > this.maxLatencyMs) {
        this.maxLatencyMs = latencyMs;
      }

      // Safe extraction of usage metadata from Gemini response
      const rawMetadata = params.response?.usageMetadata as GeminiUsageMetadata | undefined;
      const hasMetadata =
        rawMetadata !== undefined &&
        rawMetadata !== null &&
        (typeof rawMetadata.promptTokenCount === 'number' ||
          typeof rawMetadata.candidatesTokenCount === 'number' ||
          typeof rawMetadata.totalTokenCount === 'number');

      let promptTokens: number | null = null;
      let candidatesTokens: number | null = null;
      let totalTokens: number | null = null;
      let thoughtsTokens: number | null = null;
      let toolUsePromptTokens: number | null = null;
      let cachedContentTokens: number | null = null;
      let estimatedCostUsd: number | null = null;

      if (!hasMetadata) {
        this.missingMetadataRequestCount++;
      } else {
        // Extract numeric fields safely without fabricating counts
        if (typeof rawMetadata.promptTokenCount === 'number') {
          promptTokens = rawMetadata.promptTokenCount;
          this.inputTokens += promptTokens;
        }

        if (typeof rawMetadata.candidatesTokenCount === 'number') {
          candidatesTokens = rawMetadata.candidatesTokenCount;
          this.outputTokens += candidatesTokens;
        }

        // Authoritative total token count reported by Gemini
        if (typeof rawMetadata.totalTokenCount === 'number') {
          totalTokens = rawMetadata.totalTokenCount;
          this.totalTokens += totalTokens;
        } else {
          // If totalTokenCount missing but input/output present, aggregate directly
          const fallbackTotal = (promptTokens ?? 0) + (candidatesTokens ?? 0);
          this.totalTokens += fallbackTotal;
          totalTokens = fallbackTotal;
        }

        // Optional thinking tokens
        if (typeof rawMetadata.thoughtsTokenCount === 'number') {
          thoughtsTokens = rawMetadata.thoughtsTokenCount;
          this.thoughtsTokens += thoughtsTokens;
        }

        // Optional tool-use prompt tokens
        if (typeof rawMetadata.toolUsePromptTokenCount === 'number') {
          toolUsePromptTokens = rawMetadata.toolUsePromptTokenCount;
          this.toolUsePromptTokens += toolUsePromptTokens;
        }

        // Optional cached tokens
        if (typeof rawMetadata.cachedContentTokenCount === 'number') {
          cachedContentTokens = rawMetadata.cachedContentTokenCount;
          this.cachedContentTokens += cachedContentTokens;
        }

        // Calculate single response estimated cost
        const costResult = calculateResponseCost(modelId, rawMetadata);
        estimatedCostUsd = costResult.costUsd;
      }

      const record: GeminiRequestUsageRecord = {
        requestId,
        importId: this.importId,
        correlationId: this.correlationId,
        callType: params.callType,
        modelId,
        latencyMs,
        hasUsageMetadata: hasMetadata,
        promptTokenCount: promptTokens,
        candidatesTokenCount: candidatesTokens,
        totalTokenCount: totalTokens,
        thoughtsTokenCount: thoughtsTokens,
        toolUsePromptTokenCount: toolUsePromptTokens,
        cachedContentTokenCount: cachedContentTokens,
        estimatedCostUsd,
        status: 'success',
        timestamp: new Date().toISOString(),
      };

      this.requestRecords.push(record);

      auditLogger.logGeminiRequest({
        event: 'gemini_response',
        importId: this.importId,
        correlationId: this.correlationId,
        modelId,
        requestId,
        callType: params.callType,
        latencyMs,
        status: 'success',
        promptTokens: promptTokens ?? undefined,
        candidatesTokens: candidatesTokens ?? undefined,
        totalTokens: totalTokens ?? undefined,
        thoughtsTokens: thoughtsTokens ?? undefined,
        toolUseTokens: toolUsePromptTokens ?? undefined,
        cachedTokens: cachedContentTokens ?? undefined,
        estimatedCostUsd: estimatedCostUsd ?? undefined,
      });

      return record;
    } catch (err) {
      // Observability must NEVER crash the core application flow
      console.warn('[ImportUsageTracker] Failed to record Gemini response:', err);
      return null;
    }
  }

  /**
   * Records an executed backend tool call.
   * Tracks attempted, successful, and failed executions separately.
   */
  public recordToolExecution(toolName: string, success: boolean): void {
    try {
      this.functionCallAttemptedCount++;
      if (success) {
        this.functionCallSuccessCount++;
      } else {
        this.functionCallFailedCount++;
      }

      if (!this.functionCallsByTool[toolName]) {
        this.functionCallsByTool[toolName] = { executed: 0, successful: 0, failed: 0 };
      }
      this.functionCallsByTool[toolName].executed++;
      if (success) {
        this.functionCallsByTool[toolName].successful++;
      } else {
        this.functionCallsByTool[toolName].failed++;
      }
    } catch (err) {
      console.warn('[ImportUsageTracker] Failed to record tool execution:', err);
    }
  }

  /**
   * Finalizes usage and returns the aggregated import summary.
   * Idempotent: once finalized, returns the existing summary.
   */
  public finalize(): ImportAiUsageSummary {
    if (this.isFinalized && this.finalizedSummary) {
      return this.finalizedSummary;
    }

    try {
      const avgLatencyMs =
        this.successfulRequestCount > 0
          ? Math.round(this.totalLatencyMs / this.successfulRequestCount)
          : 0;

      const estimatedCost = buildEstimatedCostSummary(this.defaultModelId, {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        cachedContentTokens: this.cachedContentTokens,
        thoughtsTokens: this.thoughtsTokens,
        toolUsePromptTokens: this.toolUsePromptTokens,
      });

      const summary: ImportAiUsageSummary = {
        importId: this.importId,
        correlationId: this.correlationId,
        modelId: this.defaultModelId,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        totalTokens: this.totalTokens,
        thoughtsTokens: this.thoughtsTokens > 0 ? this.thoughtsTokens : undefined,
        toolUsePromptTokens: this.toolUsePromptTokens > 0 ? this.toolUsePromptTokens : undefined,
        cachedContentTokens: this.cachedContentTokens > 0 ? this.cachedContentTokens : undefined,
        estimatedCost,
        totalLatencyMs: this.totalLatencyMs,
        avgLatencyMs,
        maxLatencyMs: this.maxLatencyMs,
        geminiRequestCount: this.geminiRequestCount,
        successfulRequestCount: this.successfulRequestCount,
        failedRequestCount: this.failedRequestCount,
        missingMetadataRequestCount: this.missingMetadataRequestCount,
        functionCalls: {
          executed: this.functionCallAttemptedCount,
          successful: this.functionCallSuccessCount,
          failed: this.functionCallFailedCount,
          byTool: { ...this.functionCallsByTool },
        },
        updatedAt: new Date().toISOString(),
        requestRecords: [...this.requestRecords],
      };

      this.isFinalized = true;
      this.finalizedSummary = summary;

      // Emit import-level summary log
      auditLogger.logImportAiUsageSummary({
        event: 'import_ai_usage_summary',
        importId: this.importId,
        correlationId: this.correlationId,
        modelId: this.defaultModelId,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        totalTokens: summary.totalTokens,
        totalCostUsd: summary.estimatedCost.totalCostUsd,
        pricingConfigured: summary.estimatedCost.pricingConfigured,
        totalLatencyMs: summary.totalLatencyMs,
        avgLatencyMs: summary.avgLatencyMs,
        geminiRequestCount: summary.geminiRequestCount,
        functionCallsExecuted: summary.functionCalls.executed,
        functionCallsSuccessful: summary.functionCalls.successful,
        functionCallsFailed: summary.functionCalls.failed,
      });

      return summary;
    } catch (err) {
      console.warn('[ImportUsageTracker] Failed to finalize summary:', err);
      // Return a safe minimal summary
      return {
        importId: this.importId,
        correlationId: this.correlationId,
        modelId: this.defaultModelId,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        totalTokens: this.totalTokens,
        estimatedCost: {
          totalCostUsd: null,
          currency: 'USD',
          isEstimated: true,
          pricingConfigured: false,
          formattedCost: 'Unavailable',
        },
        totalLatencyMs: this.totalLatencyMs,
        avgLatencyMs: 0,
        maxLatencyMs: this.maxLatencyMs,
        geminiRequestCount: this.geminiRequestCount,
        successfulRequestCount: this.successfulRequestCount,
        failedRequestCount: this.failedRequestCount,
        missingMetadataRequestCount: this.missingMetadataRequestCount,
        functionCalls: {
          executed: this.functionCallAttemptedCount,
          successful: this.functionCallSuccessCount,
          failed: this.functionCallFailedCount,
        },
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Helper to measure latency around an async Gemini API call.
   */
  public async trackCall<T>(
    callType: GeminiCallType,
    callFn: () => Promise<T>,
    modelId?: string,
    requestId?: string
  ): Promise<T> {
    const startTime = performance.now();
    try {
      const result = await callFn();
      const latencyMs = performance.now() - startTime;
      const response = (result as { response?: unknown })?.response || result;
      this.recordGeminiResponse({
        callType,
        modelId,
        latencyMs,
        response: response as { usageMetadata?: GeminiUsageMetadata },
        requestId,
        status: 'success',
      });
      return result;
    } catch (err) {
      const latencyMs = performance.now() - startTime;
      this.recordGeminiResponse({
        callType,
        modelId,
        latencyMs,
        error: err,
        requestId,
        status: 'failed',
      });
      throw err;
    }
  }
}
