/**
 * Observability Types for Google Gemini API Token Usage, Cost, Latency & Function Calling.
 */

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface ModelPricing {
  modelId: string;
  displayName: string;
  // Rates expressed in USD per 1,000,000 tokens
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion?: number;
  thinkingCostPerMillion?: number;
  toolUsePromptCostPerMillion?: number;
  source: string;
  verifiedDate: string;
}

export interface EstimatedCostSummary {
  totalCostUsd: number | null;
  currency: 'USD';
  isEstimated: true;
  pricingConfigured: boolean;
  inputCostUsd?: number | null;
  outputCostUsd?: number | null;
  cachedCostUsd?: number | null;
  thinkingCostUsd?: number | null;
  toolUseCostUsd?: number | null;
  pricingSource?: string;
  verifiedDate?: string;
  formattedCost?: string;
}

export type GeminiCallType =
  | 'mapping_plan_initial'
  | 'mapping_plan_function_response'
  | 'batch_extraction';

export interface GeminiRequestUsageRecord {
  requestId: string;
  importId?: string;
  correlationId?: string;
  callType: GeminiCallType;
  modelId: string;
  latencyMs: number;
  hasUsageMetadata: boolean;
  promptTokenCount: number | null;
  candidatesTokenCount: number | null;
  totalTokenCount: number | null;
  thoughtsTokenCount?: number | null;
  toolUsePromptTokenCount?: number | null;
  cachedContentTokenCount?: number | null;
  estimatedCostUsd: number | null;
  status: 'success' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  timestamp: string;
}

export interface FunctionCallStats {
  executed: number;
  successful: number;
  failed: number;
  byTool?: Record<string, { executed: number; successful: number; failed: number }>;
}

export interface ImportAiUsageSummary {
  importId: string;
  correlationId?: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  thoughtsTokens?: number;
  toolUsePromptTokens?: number;
  cachedContentTokens?: number;
  estimatedCost: EstimatedCostSummary;
  totalLatencyMs: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  geminiRequestCount: number;
  successfulRequestCount: number;
  failedRequestCount: number;
  missingMetadataRequestCount: number;
  functionCalls: FunctionCallStats;
  updatedAt: string;
  requestRecords?: GeminiRequestUsageRecord[];
}
