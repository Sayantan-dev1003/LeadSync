import { sanitizeLogMessage } from '../lib/sanitizer';

export interface ToolExecutionRecord {
  toolName: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface MappingPlanMetrics {
  operation: 'gemini_tool_mapping_plan';
  modelRequestsCount: number;
  toolCallsCount: number;
  toolNamesRequested: string[];
  toolCallsExecuted: number;
  toolCallsFailed: number;
  roundsCount: number;
  latencyMs: number;
  fallbackOccurred: boolean;
  tokenUsage?: {
    promptTokens?: number;
    candidatesTokens?: number;
    totalTokens?: number;
  };
  toolExecutionRecords: ToolExecutionRecord[];
}

/**
 * Lightweight, safe logger for Gemini function-calling and tool orchestration.
 * Strict privacy: Never logs raw CSV data, PII (names, emails, phones), or secret keys.
 */
export class ToolObservabilityTracker {
  private startTime: number;
  private metrics: MappingPlanMetrics;

  constructor() {
    this.startTime = Date.now();
    this.metrics = {
      operation: 'gemini_tool_mapping_plan',
      modelRequestsCount: 0,
      toolCallsCount: 0,
      toolNamesRequested: [],
      toolCallsExecuted: 0,
      toolCallsFailed: 0,
      roundsCount: 0,
      latencyMs: 0,
      fallbackOccurred: false,
      toolExecutionRecords: [],
    };
  }

  recordModelRequest(): void {
    this.metrics.modelRequestsCount += 1;
  }

  recordRound(): void {
    this.metrics.roundsCount += 1;
  }

  recordToolCall(toolName: string, success: boolean, durationMs: number, error?: string): void {
    this.metrics.toolCallsCount += 1;
    this.metrics.toolNamesRequested.push(toolName);
    if (success) {
      this.metrics.toolCallsExecuted += 1;
    } else {
      this.metrics.toolCallsFailed += 1;
    }
    this.metrics.toolExecutionRecords.push({
      toolName,
      success,
      durationMs,
      error: error ? sanitizeLogMessage(error) : undefined,
    });
  }

  recordFallback(reason: string): void {
    this.metrics.fallbackOccurred = true;
    const safeReason = sanitizeLogMessage(reason);
    console.warn(`[ToolObservability] Mapping planning fallback triggered: ${safeReason}`);
  }

  recordTokenUsage(usage?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }): void {
    if (!usage) return;
    const current = this.metrics.tokenUsage || { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 };
    this.metrics.tokenUsage = {
      promptTokens: (current.promptTokens || 0) + (usage.promptTokenCount || 0),
      candidatesTokens: (current.candidatesTokens || 0) + (usage.candidatesTokenCount || 0),
      totalTokens: (current.totalTokens || 0) + (usage.totalTokenCount || ((usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0))),
    };
  }

  finalize(): MappingPlanMetrics {
    this.metrics.latencyMs = Date.now() - this.startTime;
    return { ...this.metrics };
  }

  logSummary(): void {
    const finalized = this.finalize();
    console.info(
      `[ToolObservability] Completed in ${finalized.latencyMs}ms | ` +
      `Requests: ${finalized.modelRequestsCount} | ` +
      `Rounds: ${finalized.roundsCount} | ` +
      `Tools Called: ${finalized.toolCallsCount} (${finalized.toolNamesRequested.join(', ') || 'none'}) | ` +
      `Executed: ${finalized.toolCallsExecuted} | ` +
      `Failed: ${finalized.toolCallsFailed} | ` +
      `Fallback: ${finalized.fallbackOccurred}`
    );
  }
}
