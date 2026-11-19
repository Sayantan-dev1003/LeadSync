import type { GeminiUsageMetadata, ModelPricing, EstimatedCostSummary } from '../types/observability';

/**
 * Official Google Gemini API Pricing Registry
 *
 * Rates are expressed in USD per 1,000,000 tokens (1M tokens).
 *
 * Documentation & Sources:
 * - Google AI Studio Official Pay-as-you-go Pricing: https://ai.google.dev/pricing
 * - Verified Date: 2026-11-19
 *
 * Note: Costs calculated here are estimates based on recorded usage metadata
 * and official published rates. They are not a replacement for Google Cloud Billing data.
 */
export const OFFICIAL_GEMINI_PRICING_CATALOG: Record<string, ModelPricing> = {
  // Configured default model for LeadSync
  'gemini-2.5-flash': {
    modelId: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    inputCostPerMillion: 0.30,          // $0.30 per 1M prompt tokens
    outputCostPerMillion: 2.50,         // $2.50 per 1M candidate/output tokens (includes thinking tokens)
    cachedInputCostPerMillion: 0.03,    // $0.03 per 1M cached prompt tokens
    thinkingCostPerMillion: 2.50,       // Thinking tokens billed at output rate
    toolUsePromptCostPerMillion: 0.30,  // Tool-use prompts billed at input rate
    source: 'Google AI Studio / Gemini API Official Pay-as-you-go Pricing',
    verifiedDate: '2026-11-19',
  },
  'gemini-1.5-flash': {
    modelId: 'gemini-1.5-flash',
    displayName: 'Gemini 1.5 Flash',
    inputCostPerMillion: 0.075,
    outputCostPerMillion: 0.30,
    cachedInputCostPerMillion: 0.01875,
    thinkingCostPerMillion: 0.30,
    toolUsePromptCostPerMillion: 0.075,
    source: 'Google AI Studio Official Pay-as-you-go Pricing',
    verifiedDate: '2026-11-19',
  },
  'gemini-1.5-pro': {
    modelId: 'gemini-1.5-pro',
    displayName: 'Gemini 1.5 Pro',
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 5.00,
    cachedInputCostPerMillion: 0.3125,
    thinkingCostPerMillion: 5.00,
    toolUsePromptCostPerMillion: 1.25,
    source: 'Google AI Studio Official Pay-as-you-go Pricing',
    verifiedDate: '2026-11-19',
  },
  'gemini-2.0-flash': {
    modelId: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    inputCostPerMillion: 0.10,
    outputCostPerMillion: 0.40,
    cachedInputCostPerMillion: 0.025,
    thinkingCostPerMillion: 0.40,
    toolUsePromptCostPerMillion: 0.10,
    source: 'Google AI Studio Official Pay-as-you-go Pricing',
    verifiedDate: '2026-11-19',
  },
  'gemini-2.0-flash-exp': {
    modelId: 'gemini-2.0-flash-exp',
    displayName: 'Gemini 2.0 Flash Experimental',
    inputCostPerMillion: 0.10,
    outputCostPerMillion: 0.40,
    cachedInputCostPerMillion: 0.025,
    thinkingCostPerMillion: 0.40,
    toolUsePromptCostPerMillion: 0.10,
    source: 'Google AI Studio Official Pay-as-you-go Pricing',
    verifiedDate: '2026-11-19',
  },
};

// Dynamic registry allowing runtime extension / test overrides
const customPricingCatalog = new Map<string, ModelPricing>();

/**
 * Normalizes a model identifier string (e.g. "models/gemini-2.5-flash" -> "gemini-2.5-flash").
 */
export function normalizeModelId(rawModelId: string): string {
  if (!rawModelId) return '';
  let normalized = rawModelId.trim().toLowerCase();
  if (normalized.startsWith('models/')) {
    normalized = normalized.slice(7);
  }
  return normalized;
}

/**
 * Resolves the pricing configuration for a given model identifier.
 * Checks environment overrides, custom runtime registrations, and the official catalog.
 */
export function getModelPricing(modelId: string): ModelPricing | undefined {
  const normalized = normalizeModelId(modelId);

  // 1. Check custom runtime registrations
  if (customPricingCatalog.has(normalized)) {
    return customPricingCatalog.get(normalized);
  }

  // 2. Check environment variable overrides for custom rates
  const envInputRate = process.env.GEMINI_PRICING_INPUT_PER_1M;
  const envOutputRate = process.env.GEMINI_PRICING_OUTPUT_PER_1M;
  if (envInputRate && envOutputRate) {
    const parsedInput = parseFloat(envInputRate);
    const parsedOutput = parseFloat(envOutputRate);
    if (!isNaN(parsedInput) && !isNaN(parsedOutput) && parsedInput >= 0 && parsedOutput >= 0) {
      return {
        modelId: normalized,
        displayName: `${normalized} (Env Configured)`,
        inputCostPerMillion: parsedInput,
        outputCostPerMillion: parsedOutput,
        source: 'Environment Variable Override',
        verifiedDate: new Date().toISOString().split('T')[0],
      };
    }
  }

  // 3. Exact match in official catalog
  if (OFFICIAL_GEMINI_PRICING_CATALOG[normalized]) {
    return OFFICIAL_GEMINI_PRICING_CATALOG[normalized];
  }

  // 4. Prefix match (e.g. "gemini-2.5-flash-001" or "gemini-2.5-flash-preview")
  for (const [key, pricing] of Object.entries(OFFICIAL_GEMINI_PRICING_CATALOG)) {
    if (normalized.startsWith(key)) {
      return {
        ...pricing,
        modelId: normalized,
      };
    }
  }

  return undefined;
}

/**
 * Registers custom pricing at runtime (useful for testing or future models).
 */
export function registerModelPricing(pricing: ModelPricing): void {
  customPricingCatalog.set(normalizeModelId(pricing.modelId), pricing);
}

/**
 * Clears custom pricing registrations (used in test teardown).
 */
export function clearCustomModelPricing(): void {
  customPricingCatalog.clear();
}

export interface SingleResponseCostResult {
  costUsd: number | null;
  pricingConfigured: boolean;
  breakdown?: {
    inputCostUsd: number;
    outputCostUsd: number;
    cachedCostUsd: number;
  };
}

/**
 * Calculates the estimated cost for a single Gemini API response.
 *
 * Returns costUsd = null if pricing cannot be established or metadata is missing.
 * Prevents double-counting by subtracting cachedContentTokenCount from promptTokenCount.
 */
export function calculateResponseCost(
  modelId: string,
  usage?: GeminiUsageMetadata
): SingleResponseCostResult {
  if (!usage) {
    return { costUsd: null, pricingConfigured: false };
  }

  const pricing = getModelPricing(modelId);
  if (!pricing) {
    return { costUsd: null, pricingConfigured: false };
  }

  const promptTokens = usage.promptTokenCount ?? 0;
  const candidatesTokens = usage.candidatesTokenCount ?? 0;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;

  // Cached tokens are discounted; subtract from prompt tokens to avoid double billing
  const uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);

  const inputCost = (uncachedPromptTokens * pricing.inputCostPerMillion) / 1_000_000;
  const cachedCost = (cachedTokens * (pricing.cachedInputCostPerMillion ?? pricing.inputCostPerMillion)) / 1_000_000;
  const outputCost = (candidatesTokens * pricing.outputCostPerMillion) / 1_000_000;

  const totalCost = inputCost + cachedCost + outputCost;

  return {
    costUsd: totalCost,
    pricingConfigured: true,
    breakdown: {
      inputCostUsd: inputCost,
      outputCostUsd: outputCost,
      cachedCostUsd: cachedCost,
    },
  };
}

/**
 * Formats a USD cost for user display with currency label.
 * Returns "Unavailable" when cost is null.
 */
export function formatCostUsd(costUsd: number | null | undefined): string {
  if (costUsd === null || costUsd === undefined || isNaN(costUsd)) {
    return 'Unavailable';
  }
  if (costUsd === 0) {
    return '$0.00';
  }
  if (costUsd < 0.0001) {
    return '< $0.0001';
  }
  if (costUsd < 0.01) {
    return `$${costUsd.toFixed(4)}`;
  }
  return `$${costUsd.toFixed(2)}`;
}

/**
 * Calculates the aggregated cost summary for an entire import across all requests.
 */
export function buildEstimatedCostSummary(
  modelId: string,
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedContentTokens?: number;
    thoughtsTokens?: number;
    toolUsePromptTokens?: number;
  }
): EstimatedCostSummary {
  const pricing = getModelPricing(modelId);

  if (!pricing) {
    return {
      totalCostUsd: null,
      currency: 'USD',
      isEstimated: true,
      pricingConfigured: false,
      formattedCost: 'Unavailable (Pricing not configured)',
    };
  }

  const cachedTokens = totals.cachedContentTokens ?? 0;
  const uncachedPromptTokens = Math.max(0, totals.inputTokens - cachedTokens);
  const candidatesTokens = totals.outputTokens;

  const inputCostUsd = (uncachedPromptTokens * pricing.inputCostPerMillion) / 1_000_000;
  const cachedCostUsd = (cachedTokens * (pricing.cachedInputCostPerMillion ?? pricing.inputCostPerMillion)) / 1_000_000;
  const outputCostUsd = (candidatesTokens * pricing.outputCostPerMillion) / 1_000_000;

  const totalCostUsd = inputCostUsd + cachedCostUsd + outputCostUsd;

  return {
    totalCostUsd,
    currency: 'USD',
    isEstimated: true,
    pricingConfigured: true,
    inputCostUsd,
    outputCostUsd,
    cachedCostUsd,
    pricingSource: pricing.source,
    verifiedDate: pricing.verifiedDate,
    formattedCost: formatCostUsd(totalCostUsd),
  };
}
