import { FunctionDeclaration } from '@google/generative-ai';
import { getCrmSchema, getCrmSchemaDeclaration, GetCrmSchemaArgsSchema } from './crmSchema.tool';
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
import { auditLogger } from '../auditLogger.service';
import { sanitizeLogMessage } from '../../lib/sanitizer';
import type { AuthUser } from '../../middleware/auth.middleware';

export interface ToolExecutionContext {
  availableHeaders: string[];
  userId?: string;
  user?: AuthUser;
  importId?: string;
  correlationId?: string;
  pendingImportOwnerId?: string;
  orchestrationRound?: number;
}

export interface ToolExecutionOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
}

export interface RegisteredTool {
  declaration: FunctionDeclaration;
  execute: (args: unknown, context: ToolExecutionContext) => unknown | Promise<unknown>;
  validateArgs?: (args: unknown) => { success: boolean; error?: string };
}

export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  errorCode?: string;
  durationMs?: number;
  retries?: number;
}

/**
 * Strict allowlist of registered backend tools.
 * Only tools explicitly defined here can ever be invoked by Gemini.
 * Centralized registry — no dynamic function loading or arbitrary execution.
 */
export const TOOL_REGISTRY: Record<string, RegisteredTool> = {
  get_crm_schema: {
    declaration: getCrmSchemaDeclaration,
    validateArgs: (args: unknown) => {
      if (args === undefined || args === null) return { success: true };
      const res = GetCrmSchemaArgsSchema.safeParse(args);
      return res.success
        ? { success: true }
        : { success: false, error: res.error.issues.map((i) => i.message).join('; ') };
    },
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
 * Determines whether a tool execution error is transient and eligible for retry.
 */
function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes('transient') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('network') ||
    message.includes('temporar') ||
    message.includes('busy')
  );
}

/**
 * Secure dispatcher that executes a registered backend tool with:
 * 1. Centralized Allowlist verification (rejects any unknown tool name)
 * 2. Server-side Authorization and Import Ownership validation
 * 3. Strict Zod argument validation (rejects invalid/unexpected fields)
 * 4. Bounded execution timeout & bounded exponential-backoff retries for transient failures
 * 5. Structured audit logging (started, succeeded, failed) with sensitive data redaction
 */
export async function executeBackendTool(
  toolName: string,
  rawArgs: unknown,
  context: ToolExecutionContext,
  options: ToolExecutionOptions = {}
): Promise<ToolExecutionResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxRetries = options.maxRetries ?? 2;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 50;

  // ---------------------------------------------------------------------------
  // 1. Centralized Allowlist Verification
  // ---------------------------------------------------------------------------
  if (!Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, toolName)) {
    const errorMsg = `Unauthorized or unknown tool: "${toolName}". Allowed tools: ${ALLOWED_TOOL_NAMES.join(', ')}`;
    auditLogger.logToolExecutionFailed({
      toolName,
      importId: context.importId,
      correlationId: context.correlationId,
      status: 'failed',
      errorCode: 'UNKNOWN_TOOL',
      errorCategory: 'ALLOWLIST_REJECTION',
      errorMessage: errorMsg,
      orchestrationRound: context.orchestrationRound,
    });
    return {
      success: false,
      errorCode: 'UNKNOWN_TOOL',
      error: errorMsg,
      durationMs: Date.now() - startTime,
    };
  }

  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    const errorMsg = `Unauthorized or unknown tool: "${toolName}". Allowed tools: ${ALLOWED_TOOL_NAMES.join(', ')}`;
    auditLogger.logToolExecutionFailed({
      toolName,
      importId: context.importId,
      correlationId: context.correlationId,
      status: 'failed',
      errorCode: 'UNKNOWN_TOOL',
      errorCategory: 'ALLOWLIST_REJECTION',
      errorMessage: errorMsg,
      orchestrationRound: context.orchestrationRound,
    });
    return {
      success: false,
      errorCode: 'UNKNOWN_TOOL',
      error: errorMsg,
      durationMs: Date.now() - startTime,
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Server-Side Authorization & Ownership Enforcement
  // ---------------------------------------------------------------------------
  if (context.user && context.user.role !== 'owner') {
    const errorMsg = `Unauthorized tool execution: User "${context.user.email || context.user.id}" lacks required owner privileges.`;
    auditLogger.logToolExecutionFailed({
      toolName,
      importId: context.importId,
      correlationId: context.correlationId,
      status: 'failed',
      errorCode: 'UNAUTHORIZED_TOOL_EXECUTION',
      errorCategory: 'AUTHORIZATION_FAILURE',
      errorMessage: errorMsg,
      orchestrationRound: context.orchestrationRound,
    });
    return {
      success: false,
      errorCode: 'UNAUTHORIZED_TOOL_EXECUTION',
      error: errorMsg,
      durationMs: Date.now() - startTime,
    };
  }

  if (
    context.pendingImportOwnerId &&
    context.userId &&
    context.pendingImportOwnerId !== context.userId
  ) {
    const errorMsg = `Unauthorized tool execution: Import owner (${context.pendingImportOwnerId}) does not match session user (${context.userId}).`;
    auditLogger.logToolExecutionFailed({
      toolName,
      importId: context.importId,
      correlationId: context.correlationId,
      status: 'failed',
      errorCode: 'UNAUTHORIZED_TOOL_EXECUTION',
      errorCategory: 'AUTHORIZATION_FAILURE',
      errorMessage: errorMsg,
      orchestrationRound: context.orchestrationRound,
    });
    return {
      success: false,
      errorCode: 'UNAUTHORIZED_TOOL_EXECUTION',
      error: errorMsg,
      durationMs: Date.now() - startTime,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Strict Zod Argument Validation
  // ---------------------------------------------------------------------------
  if (tool.validateArgs) {
    const valResult = tool.validateArgs(rawArgs);
    if (!valResult.success) {
      const errorMsg = `Invalid arguments for tool "${toolName}": ${valResult.error}`;
      auditLogger.logToolExecutionFailed({
        toolName,
        importId: context.importId,
        correlationId: context.correlationId,
        status: 'failed',
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        errorCategory: 'ARGUMENT_VALIDATION_FAILURE',
        errorMessage: errorMsg,
        orchestrationRound: context.orchestrationRound,
      });
      return {
        success: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Bounded Tool Execution with Timeout & Transient Retries
  // ---------------------------------------------------------------------------
  auditLogger.logToolExecutionStarted({
    toolName,
    importId: context.importId,
    correlationId: context.correlationId,
    orchestrationRound: context.orchestrationRound,
  });

  let retryCount = 0;
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const attemptStartTime = Date.now();
    try {
      const result = await Promise.race([
        Promise.resolve(tool.execute(rawArgs, context)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`TOOL_TIMEOUT:${timeoutMs}`)), timeoutMs)
        ),
      ]);

      const durationMs = Date.now() - startTime;
      auditLogger.logToolExecutionSucceeded({
        toolName,
        importId: context.importId,
        correlationId: context.correlationId,
        durationMs,
        orchestrationRound: context.orchestrationRound,
        retryCount,
      });

      return {
        success: true,
        data: result,
        durationMs,
        retries: retryCount,
      };
    } catch (err: unknown) {
      lastError = err;
      const isTimeout =
        err instanceof Error &&
        (err.message.startsWith('TOOL_TIMEOUT:') || err.message.includes('timed out'));

      if (isTimeout) {
        const durationMs = Date.now() - startTime;
        const errorMsg = `Tool execution timed out after ${timeoutMs}ms`;
        auditLogger.logToolExecutionFailed({
          toolName,
          importId: context.importId,
          correlationId: context.correlationId,
          status: 'failed',
          durationMs,
          errorCode: 'TOOL_TIMEOUT',
          errorCategory: 'TIMEOUT_EXCEEDED',
          errorMessage: errorMsg,
          orchestrationRound: context.orchestrationRound,
          retryCount,
        });

        return {
          success: false,
          errorCode: 'TOOL_TIMEOUT',
          error: `Execution error in tool "${toolName}": ${errorMsg}`,
          durationMs,
          retries: retryCount,
        };
      }

      // Check transient eligibility
      if (attempt <= maxRetries && isTransientError(err)) {
        retryCount++;
        const backoff = baseRetryDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }

      break;
    }
  }

  const durationMs = Date.now() - startTime;
  const rawMessage = lastError instanceof Error ? lastError.message : 'Tool execution error';
  const safeMessage = sanitizeLogMessage(rawMessage);

  auditLogger.logToolExecutionFailed({
    toolName,
    importId: context.importId,
    correlationId: context.correlationId,
    status: 'failed',
    durationMs,
    errorCode: 'TOOL_EXECUTION_ERROR',
    errorCategory: 'EXECUTION_EXCEPTION',
    errorMessage: safeMessage,
    orchestrationRound: context.orchestrationRound,
    retryCount,
  });

  return {
    success: false,
    errorCode: 'TOOL_EXECUTION_ERROR',
    error: `Execution error in tool "${toolName}": ${safeMessage}`,
    durationMs,
    retries: retryCount,
  };
}
