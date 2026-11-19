import { sanitizeLogMessage } from '../lib/sanitizer';

export type ToolExecutionStatus = 'started' | 'success' | 'failed';

export interface BaseAuditLogEvent {
  event: string;
  timestamp: string;
  correlationId?: string;
  importId?: string;
}

export interface ToolExecutionAuditLog extends BaseAuditLogEvent {
  event: 'tool_execution_started' | 'tool_execution_succeeded' | 'tool_execution_failed';
  toolName: string;
  status: ToolExecutionStatus;
  durationMs?: number;
  orchestrationRound?: number;
  retryCount?: number;
  errorCode?: string;
  errorCategory?: string;
  errorMessage?: string;
  executionLimitStatus?: {
    totalCalls: number;
    maxCalls: number;
    remaining: number;
  };
  metadata?: Record<string, unknown>;
}

export interface LifecycleAuditLog extends BaseAuditLogEvent {
  event:
    | 'import_approval_started'
    | 'import_approval_succeeded'
    | 'import_approval_failed'
    | 'import_rejection_started'
    | 'import_rejection_succeeded'
    | 'import_rejection_failed';
  status: 'started' | 'success' | 'failed';
  outcome?: string;
  durationMs?: number;
  totalImported?: number;
  errorCode?: string;
  errorMessage?: string;
  userId?: string;
}

export interface GeminiAuditLog extends BaseAuditLogEvent {
  event: 'gemini_response' | 'gemini_request_failed';
  modelId: string;
  requestId?: string;
  callType?: string;
  latencyMs?: number;
  status: 'success' | 'failed';
  promptTokens?: number;
  candidatesTokens?: number;
  totalTokens?: number;
  thoughtsTokens?: number;
  toolUseTokens?: number;
  cachedTokens?: number;
  estimatedCostUsd?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ImportAiUsageSummaryAuditLog extends BaseAuditLogEvent {
  event: 'import_ai_usage_summary';
  modelId: string;
  status?: 'success' | 'failed';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCostUsd?: number | null;
  pricingConfigured: boolean;
  totalLatencyMs: number;
  avgLatencyMs: number;
  geminiRequestCount: number;
  functionCallsExecuted: number;
  functionCallsSuccessful: number;
  functionCallsFailed: number;
}

export type AuditLogListener = (event: ToolExecutionAuditLog | LifecycleAuditLog) => void;
export type GeminiLogListener = (event: GeminiAuditLog | ImportAiUsageSummaryAuditLog) => void;

class AuditLogger {
  private listeners: Set<AuditLogListener> = new Set();
  private geminiListeners: Set<GeminiLogListener> = new Set();
  private enabled: boolean = true;

  /**
   * Subscribes an in-memory listener (used for automated tests and telemetry collectors).
   */
  public addListener(listener: AuditLogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public addGeminiListener(listener: GeminiLogListener): () => void {
    this.geminiListeners.add(listener);
    return () => this.geminiListeners.delete(listener);
  }

  public removeListener(listener: AuditLogListener): void {
    this.listeners.delete(listener);
  }

  public removeGeminiListener(listener: GeminiLogListener): void {
    this.geminiListeners.delete(listener);
  }

  public clearListeners(): void {
    this.listeners.clear();
    this.geminiListeners.clear();
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Sanitizes any object or value deeply to prevent accidental PII or secret leaks.
   */
  private redactDeep(obj: unknown, depth = 0): unknown {
    if (depth > 6 || obj == null) return obj;

    if (typeof obj === 'string') {
      return sanitizeLogMessage(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactDeep(item, depth + 1));
    }

    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      const sensitiveKeyPattern = /^(password|secret|token|authorization|cookie|session|apikey|api_key|rawrow|rawdata|prompt)$/i;

      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (sensitiveKeyPattern.test(key)) {
          result[key] = '[REDACTED_SENSITIVE_FIELD]';
        } else {
          result[key] = this.redactDeep(val, depth + 1);
        }
      }
      return result;
    }

    return obj;
  }

  private emit(log: ToolExecutionAuditLog | LifecycleAuditLog): void {
    if (!this.enabled) return;

    try {
      const sanitizedLog = this.redactDeep(log) as ToolExecutionAuditLog | LifecycleAuditLog;

      // Notify in-process listeners first
      for (const listener of this.listeners) {
        try {
          listener(sanitizedLog);
        } catch {
          // Listener failures must never crash the logger or caller
        }
      }

      // Output JSON line to standard console according to severity
      const jsonLine = JSON.stringify(sanitizedLog);
      if (sanitizedLog.status === 'failed') {
        console.error(jsonLine);
      } else {
        console.info(jsonLine);
      }
    } catch {
      // Safe fallback: Audit logging must never throw or break business logic
    }
  }

  private emitGemini(log: GeminiAuditLog | ImportAiUsageSummaryAuditLog): void {
    if (!this.enabled) return;

    try {
      const sanitizedLog = this.redactDeep(log) as GeminiAuditLog | ImportAiUsageSummaryAuditLog;

      // Notify in-process listeners
      for (const listener of this.geminiListeners) {
        try {
          listener(sanitizedLog);
        } catch {
          // Listener failures must never crash the logger
        }
      }

      // Output JSON line to console
      const jsonLine = JSON.stringify(sanitizedLog);
      if (sanitizedLog.status === 'failed') {
        console.error(jsonLine);
      } else {
        console.info(jsonLine);
      }
    } catch {
      // Safe fallback
    }
  }

  public logToolExecutionStarted(params: {
    toolName: string;
    status?: ToolExecutionStatus;
    importId?: string;
    correlationId?: string;
    orchestrationRound?: number;
    executionLimitStatus?: { totalCalls: number; maxCalls: number; remaining: number };
    metadata?: Record<string, unknown>;
  }): void {
    this.emit({
      event: 'tool_execution_started',
      timestamp: new Date().toISOString(),
      toolName: params.toolName,
      status: 'started',
      importId: params.importId,
      correlationId: params.correlationId,
      orchestrationRound: params.orchestrationRound,
      executionLimitStatus: params.executionLimitStatus,
      metadata: params.metadata,
    });
  }

  public logToolExecutionSucceeded(params: {
    toolName: string;
    status?: ToolExecutionStatus;
    importId?: string;
    correlationId?: string;
    durationMs: number;
    orchestrationRound?: number;
    retryCount?: number;
    executionLimitStatus?: { totalCalls: number; maxCalls: number; remaining: number };
    metadata?: Record<string, unknown>;
  }): void {
    this.emit({
      event: 'tool_execution_succeeded',
      timestamp: new Date().toISOString(),
      toolName: params.toolName,
      status: 'success',
      importId: params.importId,
      correlationId: params.correlationId,
      durationMs: params.durationMs,
      orchestrationRound: params.orchestrationRound,
      retryCount: params.retryCount,
      executionLimitStatus: params.executionLimitStatus,
      metadata: params.metadata,
    });
  }

  public logToolExecutionFailed(params: {
    toolName: string;
    status?: ToolExecutionStatus;
    importId?: string;
    correlationId?: string;
    durationMs?: number;
    errorCode: string;
    errorCategory?: string;
    errorMessage?: string;
    retryCount?: number;
    orchestrationRound?: number;
    executionLimitStatus?: { totalCalls: number; maxCalls: number; remaining: number };
    metadata?: Record<string, unknown>;
  }): void {
    this.emit({
      event: 'tool_execution_failed',
      timestamp: new Date().toISOString(),
      toolName: params.toolName,
      status: 'failed',
      importId: params.importId,
      correlationId: params.correlationId,
      durationMs: params.durationMs,
      errorCode: params.errorCode,
      errorCategory: params.errorCategory,
      errorMessage: params.errorMessage ? sanitizeLogMessage(params.errorMessage) : undefined,
      retryCount: params.retryCount,
      orchestrationRound: params.orchestrationRound,
      executionLimitStatus: params.executionLimitStatus,
      metadata: params.metadata,
    });
  }

  public logApprovalEvent(params: {
    event: 'import_approval_started' | 'import_approval_succeeded' | 'import_approval_failed';
    importId: string;
    correlationId?: string;
    status: 'started' | 'success' | 'failed';
    outcome?: string;
    durationMs?: number;
    totalImported?: number;
    errorCode?: string;
    errorMessage?: string;
    userId?: string;
  }): void {
    this.emit({
      event: params.event,
      timestamp: new Date().toISOString(),
      importId: params.importId,
      correlationId: params.correlationId,
      status: params.status,
      outcome: params.outcome,
      durationMs: params.durationMs,
      totalImported: params.totalImported,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage ? sanitizeLogMessage(params.errorMessage) : undefined,
      userId: params.userId,
    });
  }

  public logRejectionEvent(params: {
    event: 'import_rejection_started' | 'import_rejection_succeeded' | 'import_rejection_failed';
    importId: string;
    correlationId?: string;
    status: 'started' | 'success' | 'failed';
    outcome?: string;
    durationMs?: number;
    errorCode?: string;
    errorMessage?: string;
    userId?: string;
  }): void {
    this.emit({
      event: params.event,
      timestamp: new Date().toISOString(),
      importId: params.importId,
      correlationId: params.correlationId,
      status: params.status,
      outcome: params.outcome,
      durationMs: params.durationMs,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage ? sanitizeLogMessage(params.errorMessage) : undefined,
      userId: params.userId,
    });
  }

  public logGeminiRequest(params: {
    event: 'gemini_response' | 'gemini_request_failed';
    importId?: string;
    correlationId?: string;
    modelId: string;
    requestId?: string;
    callType?: string;
    latencyMs?: number;
    status: 'success' | 'failed';
    promptTokens?: number;
    candidatesTokens?: number;
    totalTokens?: number;
    thoughtsTokens?: number;
    toolUseTokens?: number;
    cachedTokens?: number;
    estimatedCostUsd?: number;
    errorCode?: string;
    errorMessage?: string;
  }): void {
    this.emitGemini({
      event: params.event,
      timestamp: new Date().toISOString(),
      importId: params.importId,
      correlationId: params.correlationId,
      modelId: params.modelId,
      requestId: params.requestId,
      callType: params.callType,
      latencyMs: params.latencyMs,
      status: params.status,
      promptTokens: params.promptTokens,
      candidatesTokens: params.candidatesTokens,
      totalTokens: params.totalTokens,
      thoughtsTokens: params.thoughtsTokens,
      toolUseTokens: params.toolUseTokens,
      cachedTokens: params.cachedTokens,
      estimatedCostUsd: params.estimatedCostUsd,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage ? sanitizeLogMessage(params.errorMessage) : undefined,
    });
  }

  public logImportAiUsageSummary(params: {
    event: 'import_ai_usage_summary';
    importId: string;
    correlationId?: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCostUsd?: number | null;
    pricingConfigured: boolean;
    totalLatencyMs: number;
    avgLatencyMs: number;
    geminiRequestCount: number;
    functionCallsExecuted: number;
    functionCallsSuccessful: number;
    functionCallsFailed: number;
  }): void {
    this.emitGemini({
      event: 'import_ai_usage_summary',
      timestamp: new Date().toISOString(),
      importId: params.importId,
      correlationId: params.correlationId,
      modelId: params.modelId,
      status: 'success',
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      totalTokens: params.totalTokens,
      totalCostUsd: params.totalCostUsd,
      pricingConfigured: params.pricingConfigured,
      totalLatencyMs: params.totalLatencyMs,
      avgLatencyMs: params.avgLatencyMs,
      geminiRequestCount: params.geminiRequestCount,
      functionCallsExecuted: params.functionCallsExecuted,
      functionCallsSuccessful: params.functionCallsSuccessful,
      functionCallsFailed: params.functionCallsFailed,
    });
  }
}

export const auditLogger = new AuditLogger();
