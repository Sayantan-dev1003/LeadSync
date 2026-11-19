import { FunctionDeclaration } from '@google/generative-ai';
import { getCrmSchema, getCrmSchemaDeclaration } from './crmSchema.tool';
import {
  retrieveMappingExamples,
  retrieveMappingExamplesDeclaration,
  RetrieveMappingExamplesArgsSchema,
} from './mappingExamples.tool';
import {
  validateMapping,
  validateMappingDeclaration,
  ValidateMappingArgsSchema,
} from './validateMapping.tool';

export interface ToolExecutionContext {
  availableHeaders: string[];
}

export interface RegisteredTool {
  declaration: FunctionDeclaration;
  execute: (args: unknown, context: ToolExecutionContext) => unknown | Promise<unknown>;
  validateArgs?: (args: unknown) => { success: boolean; error?: string };
}

/**
 * Strict allowlist of registered backend tools.
 * Only tools explicitly defined here can ever be invoked by Gemini.
 */
export const TOOL_REGISTRY: Record<string, RegisteredTool> = {
  get_crm_schema: {
    declaration: getCrmSchemaDeclaration,
    execute: () => getCrmSchema(),
  },
  retrieve_mapping_examples: {
    declaration: retrieveMappingExamplesDeclaration,
    validateArgs: (args: unknown) => {
      const res = RetrieveMappingExamplesArgsSchema.safeParse(args);
      return res.success
        ? { success: true }
        : { success: false, error: res.error.issues.map((i) => i.message).join('; ') };
    },
    execute: (args) => retrieveMappingExamples(args),
  },
  validate_mapping: {
    declaration: validateMappingDeclaration,
    validateArgs: (args: unknown) => {
      const res = ValidateMappingArgsSchema.safeParse(args);
      return res.success
        ? { success: true }
        : { success: false, error: res.error.issues.map((i) => i.message).join('; ') };
    },
    execute: (args, context) => validateMapping(args, { availableHeaders: context.availableHeaders }),
  },
};

export const ALLOWED_TOOL_NAMES = Object.keys(TOOL_REGISTRY);

/**
 * Returns all FunctionDeclarations to be supplied to the Gemini model.
 */
export function getRegisteredToolDeclarations(): FunctionDeclaration[] {
  return Object.values(TOOL_REGISTRY).map((t) => t.declaration);
}

/**
 * Secure dispatcher that executes a registered backend tool.
 *
 * Enforces:
 * 1. Allowlist verification (rejects any unknown tool name)
 * 2. Zod validation on incoming model arguments
 * 3. Execution boundary (no mutations, errors caught and sanitized)
 */
export async function executeBackendTool(
  toolName: string,
  rawArgs: unknown,
  context: ToolExecutionContext
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  // 1. Allowlist verification
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    return {
      success: false,
      error: `Unauthorized or unknown tool: "${toolName}". Allowed tools: ${ALLOWED_TOOL_NAMES.join(', ')}`,
    };
  }

  // 2. Argument validation
  if (tool.validateArgs) {
    const valResult = tool.validateArgs(rawArgs);
    if (!valResult.success) {
      return {
        success: false,
        error: `Invalid arguments for tool "${toolName}": ${valResult.error}`,
      };
    }
  }

  // 3. Execution
  try {
    const result = await tool.execute(rawArgs, context);
    return {
      success: true,
      data: result,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Tool execution error';
    return {
      success: false,
      error: `Execution error in tool "${toolName}": ${message}`,
    };
  }
}
