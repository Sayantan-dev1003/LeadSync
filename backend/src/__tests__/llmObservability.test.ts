import { ImportUsageTracker } from '../services/importUsageTracker';
import {
  getModelPricing,
  calculateResponseCost,
  buildEstimatedCostSummary,
  registerModelPricing,
  clearCustomModelPricing,
  formatCostUsd,
} from '../services/geminiPricing.service';
import { auditLogger, GeminiAuditLog, ImportAiUsageSummaryAuditLog } from '../services/auditLogger.service';
import { orchestrateImport } from '../services/importOrchestrator.service';
import * as aiExtractor from '../services/aiExtractor.service';
import * as geminiToolOrchestrator from '../services/geminiToolOrchestrator.service';
import type { RawRow } from '../types';

describe('LeadSync – Gemini LLM Token Usage, Cost & Latency Observability', () => {
  afterEach(() => {
    clearCustomModelPricing();
    auditLogger.clearListeners();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // Scenario 1: Correct extraction of input, output, and total tokens
  // ===========================================================================
  describe('1. Token Extraction from Gemini usageMetadata', () => {
    it('correctly extracts promptTokenCount, candidatesTokenCount, and totalTokenCount', () => {
      const tracker = new ImportUsageTracker({
        importId: 'imp_token_test_1',
        modelId: 'gemini-2.5-flash',
      });

      const record = tracker.recordGeminiResponse({
        callType: 'mapping_plan_initial',
        latencyMs: 145,
        response: {
          usageMetadata: {
            promptTokenCount: 520,
            candidatesTokenCount: 180,
            totalTokenCount: 700,
          },
        },
      });

      expect(record).not.toBeNull();
      expect(record?.promptTokenCount).toBe(520);
      expect(record?.candidatesTokenCount).toBe(180);
      expect(record?.totalTokenCount).toBe(700);
      expect(record?.hasUsageMetadata).toBe(true);

      const summary = tracker.finalize();
      expect(summary.inputTokens).toBe(520);
      expect(summary.outputTokens).toBe(180);
      expect(summary.totalTokens).toBe(700);
      expect(summary.missingMetadataRequestCount).toBe(0);
    });

    // =========================================================================
    // Scenario 2: Optional thinking, tool-use, and cached token fields
    // =========================================================================
    it('correctly extracts optional thinking, tool-use, and cached token fields when present', () => {
      const tracker = new ImportUsageTracker({
        importId: 'imp_token_test_2',
        modelId: 'gemini-2.5-flash',
      });

      const record = tracker.recordGeminiResponse({
        callType: 'batch_extraction',
        latencyMs: 250,
        response: {
          usageMetadata: {
            promptTokenCount: 1200,
            candidatesTokenCount: 600,
            totalTokenCount: 1800,
            thoughtsTokenCount: 250,
            toolUsePromptTokenCount: 150,
            cachedContentTokenCount: 400,
          },
        },
      });

      expect(record?.thoughtsTokenCount).toBe(250);
      expect(record?.toolUsePromptTokenCount).toBe(150);
      expect(record?.cachedContentTokenCount).toBe(400);

      const summary = tracker.finalize();
      expect(summary.thoughtsTokens).toBe(250);
      expect(summary.toolUsePromptTokens).toBe(150);
      expect(summary.cachedContentTokens).toBe(400);
      expect(summary.inputTokens).toBe(1200);
      expect(summary.outputTokens).toBe(600);
      expect(summary.totalTokens).toBe(1800);
    });

    // =========================================================================
    // Scenario 3: Missing usage metadata handling
    // =========================================================================
    it('handles missing usage metadata safely without fabricating token counts', () => {
      const tracker = new ImportUsageTracker({
        importId: 'imp_missing_meta',
        modelId: 'gemini-2.5-flash',
      });

      // Response without usageMetadata
      const record = tracker.recordGeminiResponse({
        callType: 'batch_extraction',
        latencyMs: 180,
        response: {},
      });

      expect(record?.hasUsageMetadata).toBe(false);
      expect(record?.promptTokenCount).toBeNull();
      expect(record?.candidatesTokenCount).toBeNull();
      expect(record?.totalTokenCount).toBeNull();

      const summary = tracker.finalize();
      expect(summary.missingMetadataRequestCount).toBe(1);
      expect(summary.geminiRequestCount).toBe(1);
      expect(summary.successfulRequestCount).toBe(1);
      expect(summary.inputTokens).toBe(0);
      expect(summary.outputTokens).toBe(0);
      expect(summary.totalTokens).toBe(0);
    });

    // =========================================================================
    // Scenario 4: Missing optional metadata fields
    // =========================================================================
    it('handles responses where optional token fields are absent without errors', () => {
      const tracker = new ImportUsageTracker({
        importId: 'imp_partial_optional',
        modelId: 'gemini-2.5-flash',
      });

      tracker.recordGeminiResponse({
        callType: 'batch_extraction',
        latencyMs: 120,
        response: {
          usageMetadata: {
            promptTokenCount: 300,
            candidatesTokenCount: 100,
            totalTokenCount: 400,
            // thoughtsTokenCount, cachedContentTokenCount, toolUsePromptTokenCount are omitted
          },
        },
      });

      const summary = tracker.finalize();
      expect(summary.inputTokens).toBe(300);
      expect(summary.outputTokens).toBe(100);
      expect(summary.totalTokens).toBe(400);
      expect(summary.thoughtsTokens).toBeUndefined();
      expect(summary.toolUsePromptTokens).toBeUndefined();
      expect(summary.cachedContentTokens).toBeUndefined();
    });
  });

  // ===========================================================================
  // Scenario 5: Aggregation across multiple Gemini responses in one import
  // ===========================================================================
  describe('2. Multi-Response Token Aggregation', () => {
    it('aggregates tokens across initial mapping plan and multiple batch extraction requests', () => {
      const tracker = new ImportUsageTracker({
        importId: 'imp_multi_call',
        modelId: 'gemini-2.5-flash',
      });

      // Call 1: Mapping planning
      tracker.recordGeminiResponse({
        callType: 'mapping_plan_initial',
        latencyMs: 200,
        response: {
          usageMetadata: {
            promptTokenCount: 400,
            candidatesTokenCount: 150,
            totalTokenCount: 550,
          },
        },
      });

      // Call 2: Batch 1 extraction
      tracker.recordGeminiResponse({
        callType: 'batch_extraction',
        latencyMs: 300,
        response: {
          usageMetadata: {
            promptTokenCount: 800,
            candidatesTokenCount: 350,
            totalTokenCount: 1150,
          },
        },
      });

      // Call 3: Batch 2 extraction
      tracker.recordGeminiResponse({
        callType: 'batch_extraction',
        latencyMs: 280,
        response: {
          usageMetadata: {
            promptTokenCount: 850,
            candidatesTokenCount: 320,
            totalTokenCount: 1170,
          },
        },
      });

      const summary = tracker.finalize();
      expect(summary.geminiRequestCount).toBe(3);
      expect(summary.successfulRequestCount).toBe(3);
      expect(summary.inputTokens).toBe(400 + 800 + 850); // 2050
      expect(summary.outputTokens).toBe(150 + 350 + 320); // 820
      expect(summary.totalTokens).toBe(550 + 1150 + 1170); // 2870
      expect(summary.totalLatencyMs).toBe(200 + 300 + 280); // 780
      expect(summary.avgLatencyMs).toBe(Math.round(780 / 3)); // 260
      expect(summary.maxLatencyMs).toBe(300);
    });
  });

  // ===========================================================================
  // Scenario 6: Aggregation across multiple function-calling rounds
  // ===========================================================================
  describe('3. Function Calling Rounds & Activity', () => {
    it('correctly aggregates usage across multiple function-calling rounds', () => {
      const tracker = new ImportUsageTracker({
        importId: 'imp_fc_rounds',
        modelId: 'gemini-2.5-flash',
      });

      // Round 1 initial prompt -> Gemini returns tool call
      tracker.recordGeminiResponse({
        callType: 'mapping_plan_initial',
        latencyMs: 150,
        response: {
          usageMetadata: {
            promptTokenCount: 300,
            candidatesTokenCount: 50,
            totalTokenCount: 350,
          },
        },
      });

      // Backend executes 2 tools
      tracker.recordToolExecution('get_crm_schema', true);
      tracker.recordToolExecution('retrieve_mapping_examples', true);

      // Round 2: Tool results sent to Gemini -> Gemini requests another tool call
      tracker.recordGeminiResponse({
        callType: 'mapping_plan_function_response',
        latencyMs: 180,
        response: {
          usageMetadata: {
            promptTokenCount: 650,
            candidatesTokenCount: 60,
            totalTokenCount: 710,
          },
        },
      });

      // Backend executes third tool
      tracker.recordToolExecution('validate_mapping', true);

      // Round 3: Final validation sent to Gemini -> Gemini outputs final mapping plan
      tracker.recordGeminiResponse({
        callType: 'mapping_plan_function_response',
        latencyMs: 160,
        response: {
          usageMetadata: {
            promptTokenCount: 900,
            candidatesTokenCount: 220,
            totalTokenCount: 1120,
          },
        },
      });

      const summary = tracker.finalize();
      expect(summary.geminiRequestCount).toBe(3);
      expect(summary.inputTokens).toBe(300 + 650 + 900); // 1850
      expect(summary.outputTokens).toBe(50 + 60 + 220); // 330
      expect(summary.totalTokens).toBe(350 + 710 + 1120); // 2180

      // Scenario 7 & 8: Function call count vs Gemini request count
      expect(summary.functionCalls.executed).toBe(3);
      expect(summary.functionCalls.successful).toBe(3);
      expect(summary.functionCalls.failed).toBe(0);
      expect(summary.geminiRequestCount).toBe(3);
      expect(summary.functionCalls.executed).not.toBe(summary.geminiRequestCount * 2);
    });

    it('tracks successful and failed tool invocations separately', () => {
      const tracker = new ImportUsageTracker({ importId: 'imp_tool_fail' });

      tracker.recordToolExecution('get_crm_schema', true);
      tracker.recordToolExecution('validate_mapping', false);
      tracker.recordToolExecution('validate_mapping', true);

      const summary = tracker.finalize();
      expect(summary.functionCalls.executed).toBe(3);
      expect(summary.functionCalls.successful).toBe(2);
      expect(summary.functionCalls.failed).toBe(1);
      expect(summary.functionCalls.byTool?.['validate_mapping'].failed).toBe(1);
      expect(summary.functionCalls.byTool?.['validate_mapping'].successful).toBe(1);
    });
  });

  // ===========================================================================
  // Scenario 9 & 10: Per-request and Aggregate LLM Latency
  // ===========================================================================
  describe('4. LLM Latency Measurement & Aggregation', () => {
    it('measures per-request latency accurately and computes total, average, and max latency', () => {
      const tracker = new ImportUsageTracker({ importId: 'imp_latency' });

      tracker.recordGeminiResponse({
        callType: 'mapping_plan_initial',
        latencyMs: 100,
        response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } },
      });

      tracker.recordGeminiResponse({
        callType: 'batch_extraction',
        latencyMs: 350,
        response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } },
      });

      tracker.recordGeminiResponse({
        callType: 'batch_extraction',
        latencyMs: 150,
        response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } },
      });

      const summary = tracker.finalize();
      expect(summary.totalLatencyMs).toBe(600);
      expect(summary.avgLatencyMs).toBe(200);
      expect(summary.maxLatencyMs).toBe(350);
    });
  });

  // ===========================================================================
  // Scenario 11 & 12: Estimated Cost Calculation
  // ===========================================================================
  describe('5. Estimated API Cost Calculation & Pricing Registry', () => {
    it('uses configured model-specific rates (gemini-2.5-flash) and discounts cached tokens without double counting', () => {
      // Rates for gemini-2.5-flash:
      // input: $0.30 per 1M, output: $2.50 per 1M, cached: $0.03 per 1M
      const pricing = getModelPricing('gemini-2.5-flash');
      expect(pricing).toBeDefined();
      expect(pricing?.inputCostPerMillion).toBe(0.30);
      expect(pricing?.outputCostPerMillion).toBe(2.50);
      expect(pricing?.cachedInputCostPerMillion).toBe(0.03);

      // Single response with 10,000 prompt tokens (including 2,000 cached) and 4,000 output tokens
      // Uncached prompt = 8,000 tokens => (8000 * 0.30) / 1,000,000 = $0.0024
      // Cached prompt = 2,000 tokens => (2000 * 0.03) / 1,000,000 = $0.00006
      // Output = 4,000 tokens => (4000 * 2.50) / 1,000,000 = $0.0100
      // Total = 0.0024 + 0.00006 + 0.0100 = 0.01246
      const costResult = calculateResponseCost('gemini-2.5-flash', {
        promptTokenCount: 10000,
        candidatesTokenCount: 4000,
        cachedContentTokenCount: 2000,
        totalTokenCount: 14000,
      });

      expect(costResult.pricingConfigured).toBe(true);
      expect(costResult.costUsd).toBeCloseTo(0.01246, 6);
      expect(costResult.breakdown?.inputCostUsd).toBeCloseTo(0.0024, 6);
      expect(costResult.breakdown?.cachedCostUsd).toBeCloseTo(0.00006, 6);
      expect(costResult.breakdown?.outputCostUsd).toBeCloseTo(0.01, 6);
    });

    it('calculates import-level estimated cost summary accurately', () => {
      const summary = buildEstimatedCostSummary('gemini-2.5-flash', {
        inputTokens: 1000000, // 1M tokens => $0.30
        outputTokens: 1000000, // 1M tokens => $2.50
      });

      expect(summary.pricingConfigured).toBe(true);
      expect(summary.totalCostUsd).toBeCloseTo(2.80, 4);
      expect(summary.currency).toBe('USD');
      expect(summary.formattedCost).toBe('$2.80');
      expect(summary.pricingSource).toContain('Google AI Studio');
      expect(summary.verifiedDate).toBe('2026-11-19');
    });

    it('returns cost as unavailable when pricing is not configured for an unknown model', () => {
      const costResult = calculateResponseCost('unknown-future-model-v99', {
        promptTokenCount: 500,
        candidatesTokenCount: 200,
      });

      expect(costResult.pricingConfigured).toBe(false);
      expect(costResult.costUsd).toBeNull();

      const summary = buildEstimatedCostSummary('unknown-future-model-v99', {
        inputTokens: 500,
        outputTokens: 200,
      });

      expect(summary.pricingConfigured).toBe(false);
      expect(summary.totalCostUsd).toBeNull();
      expect(summary.formattedCost).toContain('Unavailable');
    });

    it('supports custom model pricing registration and environment overrides', () => {
      registerModelPricing({
        modelId: 'custom-enterprise-gemini',
        displayName: 'Custom Enterprise Gemini',
        inputCostPerMillion: 0.50,
        outputCostPerMillion: 1.50,
        source: 'Enterprise SLA Agreement',
        verifiedDate: '2026-11-19',
      });

      const summary = buildEstimatedCostSummary('custom-enterprise-gemini', {
        inputTokens: 2000000, // 2M * $0.50 = $1.00
        outputTokens: 1000000, // 1M * $1.50 = $1.50
      });

      expect(summary.pricingConfigured).toBe(true);
      expect(summary.totalCostUsd).toBeCloseTo(2.50, 4);
    });
  });

  // ===========================================================================
  // Scenario 13: Deduplication & Idempotency
  // ===========================================================================
  describe('6. Deduplication & Idempotency', () => {
    it('does not double count tokens or latency if the same response event is processed more than once', () => {
      const tracker = new ImportUsageTracker({ importId: 'imp_dedup' });

      const sameRequestId = 'req_unique_event_123';

      tracker.recordGeminiResponse({
        requestId: sameRequestId,
        callType: 'batch_extraction',
        latencyMs: 200,
        response: {
          usageMetadata: {
            promptTokenCount: 500,
            candidatesTokenCount: 100,
            totalTokenCount: 600,
          },
        },
      });

      // Duplicate invocation with the same requestId
      tracker.recordGeminiResponse({
        requestId: sameRequestId,
        callType: 'batch_extraction',
        latencyMs: 200,
        response: {
          usageMetadata: {
            promptTokenCount: 500,
            candidatesTokenCount: 100,
            totalTokenCount: 600,
          },
        },
      });

      const summary = tracker.finalize();
      expect(summary.geminiRequestCount).toBe(1);
      expect(summary.inputTokens).toBe(500);
      expect(summary.outputTokens).toBe(100);
      expect(summary.totalTokens).toBe(600);
      expect(summary.totalLatencyMs).toBe(200);
    });
  });

  // ===========================================================================
  // Scenario 14: Partially Failed Imports
  // ===========================================================================
  describe('7. Usage Tracking for Partially Failed Imports', () => {
    it('records failed requests as failures without assigning fabricated token counts', () => {
      const tracker = new ImportUsageTracker({ importId: 'imp_partial_fail' });

      // Successful first request
      tracker.recordGeminiResponse({
        callType: 'batch_extraction',
        latencyMs: 150,
        response: {
          usageMetadata: {
            promptTokenCount: 400,
            candidatesTokenCount: 120,
            totalTokenCount: 520,
          },
        },
      });

      // Failed second request (e.g. rate limit or network timeout)
      tracker.recordGeminiResponse({
        callType: 'batch_extraction',
        latencyMs: 500,
        status: 'failed',
        error: new Error('Gemini API timeout after 500ms'),
      });

      const summary = tracker.finalize();
      expect(summary.geminiRequestCount).toBe(2);
      expect(summary.successfulRequestCount).toBe(1);
      expect(summary.failedRequestCount).toBe(1);
      expect(summary.inputTokens).toBe(400); // Only tokens from successful request
      expect(summary.outputTokens).toBe(120);
      expect(summary.totalTokens).toBe(520);
      expect(summary.totalLatencyMs).toBe(150); // Total latency aggregates successful requests
    });
  });

  // ===========================================================================
  // Scenario 15 & 16: Non-breaking Observability & Structured Logging
  // ===========================================================================
  describe('8. Structured Logging & Safe Execution', () => {
    it('emits structured events for each Gemini response and an import-level summary', () => {
      const capturedGeminiEvents: GeminiAuditLog[] = [];
      const capturedSummaries: ImportAiUsageSummaryAuditLog[] = [];

      auditLogger.addGeminiListener((log) => {
        if (log.event === 'gemini_response' || log.event === 'gemini_request_failed') {
          capturedGeminiEvents.push(log as GeminiAuditLog);
        } else if (log.event === 'import_ai_usage_summary') {
          capturedSummaries.push(log as ImportAiUsageSummaryAuditLog);
        }
      });

      const tracker = new ImportUsageTracker({
        importId: 'imp_logging_test',
        correlationId: 'corr_test_123',
        modelId: 'gemini-2.5-flash',
      });

      tracker.recordGeminiResponse({
        callType: 'batch_extraction',
        latencyMs: 110,
        response: {
          usageMetadata: {
            promptTokenCount: 200,
            candidatesTokenCount: 80,
            totalTokenCount: 280,
          },
        },
      });

      tracker.finalize();

      expect(capturedGeminiEvents).toHaveLength(1);
      expect(capturedGeminiEvents[0].event).toBe('gemini_response');
      expect(capturedGeminiEvents[0].importId).toBe('imp_logging_test');
      expect(capturedGeminiEvents[0].promptTokens).toBe(200);
      expect(capturedGeminiEvents[0].candidatesTokens).toBe(80);
      expect(capturedGeminiEvents[0].totalTokens).toBe(280);

      expect(capturedSummaries).toHaveLength(1);
      expect(capturedSummaries[0].event).toBe('import_ai_usage_summary');
      expect(capturedSummaries[0].totalTokens).toBe(280);
      expect(capturedSummaries[0].geminiRequestCount).toBe(1);
    });

    it('never breaks import execution if usage tracker throws an internal error', async () => {
      // Mock extractBatch to return a valid result
      const sampleRows: RawRow[] = [
        { Name: 'John Doe', Email: 'john@example.com', Phone: '+1234567890' },
      ];

      const tracker = new ImportUsageTracker({ importId: 'imp_safe_exec' });
      // Intentionally cause an error inside recordGeminiResponse by poisoning private state
      (tracker as any).requestRecords = null;

      expect(() => {
        tracker.recordGeminiResponse({
          callType: 'batch_extraction',
          latencyMs: 100,
          response: { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 } },
        });
      }).not.toThrow();

      // Finalize should still safely return a fallback summary without throwing
      const summary = tracker.finalize();
      expect(summary).toBeDefined();
      expect(summary.importId).toBe('imp_safe_exec');
    });
  });

  // ===========================================================================
  // Scenario 17 & 18: Full Pipeline Integration with Mocked Gemini Responses
  // ===========================================================================
  describe('9. End-to-End Import Orchestrator Observability Integration', () => {
    it('aggregates usage across tool mapping planning and batch extraction in orchestrateImport', async () => {
      // Mock planMappingsWithTools
      jest.spyOn(geminiToolOrchestrator, 'planMappingsWithTools').mockImplementation(async (headers, opts) => {
        // Record mocked mapping planning Gemini call in tracker
        opts?.usageTracker?.recordGeminiResponse({
          callType: 'mapping_plan_initial',
          latencyMs: 180,
          response: {
            usageMetadata: {
              promptTokenCount: 450,
              candidatesTokenCount: 120,
              totalTokenCount: 570,
            },
          },
        });
        opts?.usageTracker?.recordToolExecution('get_crm_schema', true);
        opts?.usageTracker?.recordToolExecution('validate_mapping', true);

        return {
          plan: {
            mappings: [{ source: 'Full Name', target: 'name' }],
            warnings: [],
            toolCallsExecuted: ['get_crm_schema', 'validate_mapping'],
            metrics: {} as any,
          },
          fallbackOccurred: false,
        };
      });

      // Mock extractBatch
      jest.spyOn(aiExtractor, 'extractBatch').mockImplementation(async (_rows, _plan, tracker) => {
        tracker?.recordGeminiResponse({
          callType: 'batch_extraction',
          latencyMs: 220,
          response: {
            usageMetadata: {
              promptTokenCount: 600,
              candidatesTokenCount: 200,
              totalTokenCount: 800,
            },
          },
        });
        return {
          records: [
            {
              created_at: null,
              name: 'Alice',
              email: 'alice@example.com',
              country_code: null,
              mobile_without_country_code: '1234567890',
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
            },
          ],
          skipped: [],
          failed: [],
        };
      });

      const events: any[] = [];
      const result = await orchestrateImport(
        [{ 'Full Name': 'Alice', Email: 'alice@example.com', Phone: '1234567890' }],
        (evt) => events.push(evt),
        { importId: 'imp_e2e_test', headers: ['Full Name', 'Email', 'Phone'] }
      );

      expect(result.records).toHaveLength(1);
      expect(result.aiUsage).toBeDefined();

      const usage = result.aiUsage!;
      // Total tokens = 570 (mapping plan) + 800 (batch extraction) = 1370
      expect(usage.inputTokens).toBe(450 + 600); // 1050
      expect(usage.outputTokens).toBe(120 + 200); // 320
      expect(usage.totalTokens).toBe(570 + 800); // 1370
      expect(usage.geminiRequestCount).toBe(2);
      expect(usage.functionCalls.executed).toBe(2);
      expect(usage.functionCalls.successful).toBe(2);
      expect(usage.totalLatencyMs).toBe(180 + 220); // 400
      expect(usage.avgLatencyMs).toBe(200);
      expect(usage.estimatedCost.pricingConfigured).toBe(true);
      expect(usage.estimatedCost.totalCostUsd).toBeGreaterThan(0);
    });
  });
});
