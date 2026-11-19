import {
  GoogleGenerativeAI,
  FunctionCallingMode,
  Part,
} from '@google/generative-ai';
import { z } from 'zod';
import {
  executeBackendTool,
  getRegisteredToolDeclarations,
  ALLOWED_TOOL_NAMES,
} from './tools/toolRegistry';
import { validateMapping } from './tools/validateMapping.tool';
import { ToolObservabilityTracker, MappingPlanMetrics } from './toolObservability.service';
import { sanitizeLogMessage } from '../lib/sanitizer';

export interface ColumnMapping {
  source: string;
  target: string;
  reasoning?: string;
}

export interface ValidatedMappingPlan {
  mappings: ColumnMapping[];
  warnings: string[];
  toolCallsExecuted: string[];
  metrics: MappingPlanMetrics;
}

export interface ToolOrchestratorOptions {
  modelName?: string;
  maxRounds?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  temperature?: number;
}

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_MAX_TOOL_CALLS = 5;
const DEFAULT_TIMEOUT_MS = 30000;

const TOOL_ORCHESTRATOR_SYSTEM_PROMPT = `You are an expert CRM data-alignment engine for LeadSync.
Your objective is to analyze a set of source CSV column headers and produce a validated mapping plan onto the LeadSync CRM target schema.

You have access to 3 backend tools:
1. get_crm_schema: Call this tool to inspect the official 15 LeadSync CRM fields, expected data types, and enum values.
2. retrieve_mapping_examples: Call this tool with a list of source headers to lookup curated alias examples and standard real-estate CRM column mappings.
3. validate_mapping: Call this tool with your proposed mappings to check whether they conform to the schema and contain no conflicts.

## MAPPING RULES
- Supported target fields: created_at, name, email, country_code, mobile_without_country_code, company, city, state, country, lead_owner, crm_status, crm_note, data_source, possession_time, description, or unmapped.
- Every row must have at least an email or mobile number to be a valid lead; unmapped or noisy headers should be mapped to "crm_note" or "unmapped".
- If a phone column includes country code (e.g. +91), map to mobile_without_country_code and note country_code.
- For ambiguous or non-standard source headers, retrieve mapping examples before deciding.
- Always validate your proposed mapping with validate_mapping before finalizing.

## FINAL OUTPUT FORMAT
When you have completed all necessary tool calls and validations, produce your final mapping plan as a clean JSON object:
{
  "mappings": [
    {
      "source": "exact_source_header_name",
      "target": "crm_field_name_or_unmapped",
      "reasoning": "brief explanation"
    }
  ]
}
Return ONLY valid JSON for your final response.`;

const FinalMappingResponseSchema = z.object({
  mappings: z.array(
    z.object({
      source: z.string().min(1),
      target: z.string().min(1),
      reasoning: z.string().optional(),
    })
  ),
});

/**
 * Strips markdown code fences from response text.
 */
function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

/**
 * Parses the model's final response text into a mapping array.
 */
function parseFinalMappingPlan(rawText: string): ColumnMapping[] | null {
  const cleaned = stripMarkdownFences(rawText);

  try {
    const parsed = JSON.parse(cleaned);
    const validated = FinalMappingResponseSchema.safeParse(parsed);
    if (validated.success) {
      return validated.data.mappings;
    }
    // Also accept bare array
    if (Array.isArray(parsed)) {
      const arrValidated = z.array(z.object({
        source: z.string().min(1),
        target: z.string().min(1),
        reasoning: z.string().optional(),
      })).safeParse(parsed);
      if (arrValidated.success) {
        return arrValidated.data;
      }
    }
  } catch {
    // Try regex extraction of JSON object
    const match = cleaned.match(/\{[\s\S]*"mappings"[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        const validated = FinalMappingResponseSchema.safeParse(parsed);
        if (validated.success) {
          return validated.data.mappings;
        }
      } catch {}
    }
  }

  return null;
}

/**
 * Orchestrates genuine Gemini Function Calling (Tool Use) to discover and validate
 * the CSV column mapping plan before batch extraction.
 */
export async function planMappingsWithTools(
  sourceHeaders: string[],
  options: ToolOrchestratorOptions = {}
): Promise<{ plan: ValidatedMappingPlan | null; fallbackOccurred: boolean }> {
  const tracker = new ToolObservabilityTracker();

  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const modelName = options.modelName ?? process.env.GEMINI_MODEL ?? 'gemini-1.5-flash';
  const temperature = options.temperature ?? 0.1;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    tracker.recordFallback('GEMINI_API_KEY is not configured');
    tracker.logSummary();
    return { plan: null, fallbackOccurred: true };
  }

  const toolDeclarations = getRegisteredToolDeclarations();
  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: TOOL_ORCHESTRATOR_SYSTEM_PROMPT,
    tools: [{ functionDeclarations: toolDeclarations }],
    toolConfig: {
      functionCallingConfig: {
        mode: FunctionCallingMode.AUTO,
      },
    },
    generationConfig: {
      temperature,
    },
  });

  const chat = model.startChat();

  const userPrompt = `Here are the column headers extracted from the uploaded CSV:
${JSON.stringify(sourceHeaders, null, 2)}

Please determine the optimal mapping onto the LeadSync CRM target schema. Use the available backend tools to inspect the schema, retrieve known examples for unclear headers, and validate your proposed mappings. Then output the final JSON mapping plan.`;

  let totalToolCalls = 0;

  const executeWithTimeout = async (): Promise<{
    finalMappings: ColumnMapping[] | null;
    toolCallsExecuted: string[];
  }> => {
    const executed: string[] = [];
    let mappings: ColumnMapping[] | null = null;

    tracker.recordModelRequest();
    let currentResult = await chat.sendMessage(userPrompt);

    for (let round = 1; round <= maxRounds; round++) {
      tracker.recordRound();

      const response = currentResult.response;
      tracker.recordTokenUsage(response.usageMetadata);

      // Inspect native function calls from Gemini
      const functionCalls = response.functionCalls();

      // If Gemini did not call any tools, it concluded and returned the final plan
      if (!functionCalls || functionCalls.length === 0) {
        const text = response.text();
        mappings = parseFinalMappingPlan(text);
        break;
      }

      // Execute returned function calls
      const functionResponses: Part[] = [];

      for (const call of functionCalls) {
        if (totalToolCalls >= maxToolCalls) {
          console.warn(`[GeminiToolOrchestrator] Max tool calls limit (${maxToolCalls}) reached.`);
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { error: `Tool call limit of ${maxToolCalls} exceeded.` },
            },
          });
          continue;
        }

        totalToolCalls++;
        executed.push(call.name);

        const callStartTime = Date.now();
        const execResult = await executeBackendTool(call.name, call.args, {
          availableHeaders: sourceHeaders,
        });
        const durationMs = Date.now() - callStartTime;

        tracker.recordToolCall(call.name, execResult.success, durationMs, execResult.error);

        functionResponses.push({
          functionResponse: {
            name: call.name,
            response: execResult.success
              ? (execResult.data as object)
              : { error: execResult.error },
          },
        });
      }

      // Send function responses back to the model for the next turn
      tracker.recordModelRequest();
      currentResult = await chat.sendMessage(functionResponses);

      // If this was the last allowed round, attempt to parse the final response
      if (round === maxRounds) {
        const finalResponse = currentResult.response;
        tracker.recordTokenUsage(finalResponse.usageMetadata);
        mappings = parseFinalMappingPlan(finalResponse.text());
      }
    }

    return { finalMappings: mappings, toolCallsExecuted: executed };
  };

  let executionOutcome: { finalMappings: ColumnMapping[] | null; toolCallsExecuted: string[] };

  try {
    // Run conversation with overall timeout
    executionOutcome = await Promise.race([
      executeWithTimeout(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool orchestration timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : 'Unknown error during tool orchestration';
    tracker.recordFallback(rawMessage);
    tracker.logSummary();
    return { plan: null, fallbackOccurred: true };
  }

  const { finalMappings, toolCallsExecuted } = executionOutcome;

  // Authoritative server-side validation of the model-proposed mapping plan
  if (!finalMappings || finalMappings.length === 0) {
    tracker.recordFallback('Model did not produce a parseable mapping plan');
    tracker.logSummary();
    return { plan: null, fallbackOccurred: true };
  }

  const serverValidation = validateMapping(
    { mappings: finalMappings.map((m) => ({ source: m.source, target: m.target })) },
    { availableHeaders: sourceHeaders }
  );

  if (!serverValidation.valid) {
    tracker.recordFallback(`Proposed mapping plan failed server validation: ${serverValidation.errors.join('; ')}`);
    tracker.logSummary();
    return { plan: null, fallbackOccurred: true };
  }

  const plan: ValidatedMappingPlan = {
    mappings: finalMappings,
    warnings: serverValidation.warnings,
    toolCallsExecuted,
    metrics: tracker.finalize(),
  };

  tracker.logSummary();
  return { plan, fallbackOccurred: false };
}
