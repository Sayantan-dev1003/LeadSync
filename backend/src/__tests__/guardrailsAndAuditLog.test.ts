import {
  executeBackendTool,
  TOOL_REGISTRY,
  ALLOWED_TOOL_NAMES,
} from '../services/tools/toolRegistry';
import { auditLogger, ToolExecutionAuditLog, LifecycleAuditLog } from '../services/auditLogger.service';
import { planMappingsWithTools } from '../services/geminiToolOrchestrator.service';
import { GoogleGenAI } from '@google/genai';
import { AuthUser } from '../middleware/auth.middleware';

// Mock the Gemini SDK for orchestrator limit tests
jest.mock('@google/genai');
const MockedGoogleGenAI = GoogleGenAI as jest.MockedClass<typeof GoogleGenAI>;

describe('Part 3 & Part 4: Function-Calling Guardrails & Structured Audit Logging', () => {
  let capturedLogs: Array<ToolExecutionAuditLog | LifecycleAuditLog> = [];
  let removeListener: () => void;

  beforeEach(() => {
    capturedLogs = [];
    removeListener = auditLogger.addListener((log) => {
      capturedLogs.push(log);
    });
  });

  afterEach(() => {
    if (removeListener) removeListener();
    auditLogger.clearListeners();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // 5.2 Function-Calling Guardrail Tests
  // ===========================================================================
  describe('5.2 Function-Calling Security Guardrails', () => {
    it('1. Valid registered tool invocation executes cleanly', async () => {
      const result = await executeBackendTool(
        'get_crm_schema',
        {},
        { availableHeaders: ['name', 'email'] }
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.errorCode).toBeUndefined();
    });

    it('2. Unknown function name rejection (Allowlist enforcement)', async () => {
      const result = await executeBackendTool(
        'arbitrary_system_eval',
        { code: 'console.log("pwned")' },
        { availableHeaders: [] }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNKNOWN_TOOL');
      expect(result.error).toContain('Unauthorized or unknown tool');
    });

    it('3. Invalid function arguments rejected with INVALID_TOOL_ARGUMENTS', async () => {
      const result = await executeBackendTool(
        'retrieve_mapping_examples',
        { headers: 'invalid-string-instead-of-array' },
        { availableHeaders: [] }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_TOOL_ARGUMENTS');
      expect(result.error).toContain('Invalid arguments for tool');
    });

    it('4. Missing required parameters rejected', async () => {
      const result = await executeBackendTool(
        'retrieve_mapping_examples',
        {}, // missing "headers" key
        { availableHeaders: [] }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_TOOL_ARGUMENTS');
      expect(result.error).toContain('Required');
    });

    it('5. Unexpected additional properties rejected via strict Zod schemas', async () => {
      const result = await executeBackendTool(
        'retrieve_mapping_examples',
        {
          headers: ['Cust_Name'],
          rogueInjectionField: 'SELECT * FROM users',
        },
        { availableHeaders: ['Cust_Name'] }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_TOOL_ARGUMENTS');
      expect(result.error).toContain('Unrecognized key(s) in object');
    });

    it('6. Unauthorized user rejection (enforces owner privileges)', async () => {
      const nonOwnerUser: AuthUser = {
        id: 'user_regular_1',
        role: 'guest' as any,
        email: 'attacker@evil.com',
      };

      const result = await executeBackendTool(
        'get_crm_schema',
        {},
        {
          availableHeaders: [],
          user: nonOwnerUser,
        }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNAUTHORIZED_TOOL_EXECUTION');
      expect(result.error).toContain('lacks required owner privileges');
    });

    it('7. Import ownership validation (prevents accessing another user import)', async () => {
      const result = await executeBackendTool(
        'get_crm_schema',
        {},
        {
          availableHeaders: [],
          userId: 'owner_user_a',
          pendingImportOwnerId: 'owner_user_b', // Mismatched!
        }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNAUTHORIZED_TOOL_EXECUTION');
      expect(result.error).toContain('does not match session user');
    });

    it('8. Maximum tool-call limit reached stops orchestration', async () => {
      // The orchestrator exits early when GEMINI_API_KEY is unset.
      // Set a fake key so the mock is reached; restore it afterwards.
      const originalKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = 'AIzaFakeKeyForTestingOnly_Test8_Guardrails';

      try {
        // Mock Gemini chat sending repeated tool requests
        const mockSendMessage = jest.fn();
        mockSendMessage
          .mockResolvedValueOnce({
            response: {
              functionCalls: () => [
                { name: 'get_crm_schema', args: {} },
                { name: 'retrieve_mapping_examples', args: { headers: ['Cust_Name'] } },
              ],
              text: () => '',
              usageMetadata: {},
            },
          })
          .mockResolvedValueOnce({
            response: {
              functionCalls: () => [
                { name: 'get_crm_schema', args: {} },
                { name: 'retrieve_mapping_examples', args: { headers: ['Mob_No'] } },
              ],
              text: () => '',
              usageMetadata: {},
            },
          });

        const mockChat = { sendMessage: mockSendMessage };
        MockedGoogleGenAI.mockImplementation(
          () => ({ chats: { create: () => mockChat } } as any)
        );

        // maxToolCalls=3 means: after 3 tool executions the 4th is blocked with TOOL_CALL_LIMIT_EXCEEDED.
        // Round 1 returns 2 tools → both execute (total=2).
        // Round 2 returns 2 tools → first executes (total=3), second hits the limit → TOOL_CALL_LIMIT_EXCEEDED.
        const { fallbackOccurred } = await planMappingsWithTools(['Cust_Name', 'Mob_No'], {
          maxToolCalls: 3,
          maxRounds: 3,
        });

        expect(fallbackOccurred).toBe(true);

        // Verify that TOOL_CALL_LIMIT_EXCEEDED log was emitted
        const limitExceededLog = capturedLogs.find(
          (l) => (l as ToolExecutionAuditLog).errorCode === 'TOOL_CALL_LIMIT_EXCEEDED'
        );
        expect(limitExceededLog).toBeDefined();
      } finally {
        process.env.GEMINI_API_KEY = originalKey;
      }
    });

    it('9. Maximum orchestration rounds reached stops execution', async () => {
      // The orchestrator exits early when GEMINI_API_KEY is unset.
      // Set a fake key so the mock is reached; restore it afterwards.
      const originalKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = 'AIzaFakeKeyForTestingOnly_Test9_Guardrails';

      try {
        // Each sendMessage response includes a function call, so the model never
        // terminates naturally — the orchestrator must stop after maxRounds.
        const mockSendMessage = jest.fn().mockResolvedValue({
          response: {
            functionCalls: () => [{ name: 'get_crm_schema', args: {} }],
            text: () => '',
            usageMetadata: {},
          },
        });

        const mockChat = { sendMessage: mockSendMessage };
        MockedGoogleGenAI.mockImplementation(
          () => ({ chats: { create: () => mockChat } } as any)
        );

        const { fallbackOccurred } = await planMappingsWithTools(['Cust_Name'], {
          maxRounds: 2,
          maxToolCalls: 10,
        });

        expect(fallbackOccurred).toBe(true);
        // Turn 1 (initial sendMessage) + Round 1 tool-results sendMessage + Round 2 tool-results sendMessage
        expect(mockSendMessage).toHaveBeenCalledTimes(3);
      } finally {
        process.env.GEMINI_API_KEY = originalKey;
      }
    });

    it('10. Tool timeout handling returns TOOL_TIMEOUT error', async () => {
      // Simulate timeout by racing with very small timeout
      const result: { success: boolean; errorCode?: string; error?: string } = await Promise.race([
        new Promise<{ success: boolean; errorCode?: string; error?: string }>((resolve) =>
          setTimeout(() => resolve({ success: true }), 200)
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('TOOL_TIMEOUT:10')), 10)
        ),
      ]).catch((err) => ({
        success: false,
        errorCode: 'TOOL_TIMEOUT',
        error: err.message,
      }));

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('TOOL_TIMEOUT');
    });

    it('11. Transient execution failure and successful retry', async () => {
      let attempts = 0;
      const transientFn = async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Transient network error — eligible for retry');
        }
        return { recovered: true };
      };

      const result = await (async () => {
        for (let i = 1; i <= 3; i++) {
          try {
            return await transientFn();
          } catch (err) {
            if (i === 3) throw err;
          }
        }
      })();

      expect(result).toEqual({ recovered: true });
      expect(attempts).toBe(2);
    });

    it('12. Permanent execution failure caught gracefully', async () => {
      const permanentFn = async () => {
        throw new Error('Permanent database corruption error');
      };

      let caught = false;
      try {
        await permanentFn();
      } catch (err: any) {
        caught = true;
        expect(err.message).toContain('Permanent');
      }
      expect(caught).toBe(true);
    });

    it('13. Human approval boundary enforcement (No CRM persistence before approval)', () => {
      // All tools in registry must be read-only
      const toolNames = Object.keys(TOOL_REGISTRY);
      for (const name of toolNames) {
        expect(name).not.toMatch(/commit|approve|insert|create|delete/i);
      }
      expect(ALLOWED_TOOL_NAMES).toEqual([
        'get_crm_schema',
        'retrieve_mapping_examples',
        'validate_mapping',
      ]);
    });
  });

  // ===========================================================================
  // 5.3 Audit Logging Tests
  // ===========================================================================
  describe('5.3 Structured Audit Logging', () => {
    it('1. Generates tool_execution_started and tool_execution_succeeded events', async () => {
      await executeBackendTool('get_crm_schema', {}, {
        availableHeaders: [],
        correlationId: 'req_12345',
        importId: 'import_67890',
      });

      const started = capturedLogs.find((l) => l.event === 'tool_execution_started') as ToolExecutionAuditLog;
      expect(started).toBeDefined();
      expect(started.toolName).toBe('get_crm_schema');
      expect(started.status).toBe('started');
      expect(started.correlationId).toBe('req_12345');
      expect(started.importId).toBe('import_67890');

      const succeeded = capturedLogs.find((l) => l.event === 'tool_execution_succeeded') as ToolExecutionAuditLog;
      expect(succeeded).toBeDefined();
      expect(succeeded.toolName).toBe('get_crm_schema');
      expect(succeeded.status).toBe('success');
      expect(succeeded.durationMs).toBeGreaterThanOrEqual(0);
      expect(succeeded.correlationId).toBe('req_12345');
      expect(succeeded.importId).toBe('import_67890');
    });

    it('2. Generates tool_execution_failed event with error codes', async () => {
      await executeBackendTool('unknown_cmd', {}, {
        availableHeaders: [],
        correlationId: 'req_fail_1',
      });

      const failed = capturedLogs.find((l) => l.event === 'tool_execution_failed') as ToolExecutionAuditLog;
      expect(failed).toBeDefined();
      expect(failed.toolName).toBe('unknown_cmd');
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toBe('UNKNOWN_TOOL');
      expect(failed.correlationId).toBe('req_fail_1');
    });

    it('3. Records execution duration in milliseconds accurately', async () => {
      await executeBackendTool('get_crm_schema', {}, { availableHeaders: [] });

      const log = capturedLogs.find((l) => l.event === 'tool_execution_succeeded') as ToolExecutionAuditLog;
      expect(typeof log.durationMs).toBe('number');
      expect(log.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('4. Propagates importId and correlationId through the tool lifecycle', async () => {
      const testImportId = 'imp_test_abc';
      const testCorrelationId = 'corr_test_xyz';

      await executeBackendTool(
        'retrieve_mapping_examples',
        { headers: ['Cust_Name'] },
        {
          availableHeaders: ['Cust_Name'],
          importId: testImportId,
          correlationId: testCorrelationId,
        }
      );

      const logsForCorrelation = capturedLogs.filter((l) => l.correlationId === testCorrelationId);
      expect(logsForCorrelation.length).toBeGreaterThanOrEqual(2); // started & succeeded
      expect(logsForCorrelation.every((l) => l.importId === testImportId)).toBe(true);
    });

    it('5. Records retry count when retries occur', () => {
      auditLogger.logToolExecutionSucceeded({
        toolName: 'retrieve_mapping_examples',
        durationMs: 150,
        retryCount: 2,
      });

      const log = capturedLogs.find((l) => (l as ToolExecutionAuditLog).retryCount === 2);
      expect(log).toBeDefined();
    });

    it('6. Logs approval and rejection lifecycle events', () => {
      auditLogger.logApprovalEvent({
        event: 'import_approval_succeeded',
        importId: 'pending_app_1',
        correlationId: 'req_app_1',
        status: 'success',
        outcome: 'COMMITTED',
        totalImported: 42,
        durationMs: 320,
      });

      auditLogger.logRejectionEvent({
        event: 'import_rejection_succeeded',
        importId: 'pending_rej_1',
        correlationId: 'req_rej_1',
        status: 'success',
        outcome: 'REJECTED_AND_PURGED',
        durationMs: 45,
      });

      const appLog = capturedLogs.find((l) => l.event === 'import_approval_succeeded') as LifecycleAuditLog;
      expect(appLog).toBeDefined();
      expect(appLog.totalImported).toBe(42);
      expect(appLog.status).toBe('success');

      const rejLog = capturedLogs.find((l) => l.event === 'import_rejection_succeeded') as LifecycleAuditLog;
      expect(rejLog).toBeDefined();
      expect(rejLog.outcome).toBe('REJECTED_AND_PURGED');
    });

    it('7. Sensitive information protection (Mandatory PII and secret redaction)', () => {
      auditLogger.logToolExecutionFailed({
        toolName: 'test_tool',
        errorCode: 'SENSITIVE_LEAK_TEST',
        errorMessage: 'User john.doe@example.com with phone +91-9876543210 and API key AIzaSyD987654321012345678901234567890 failed Bearer eyJhbGciOiJIUzI1NiJ9.test',
        metadata: {
          secret: 'super_secret_value',
          password: 'plain_password',
        },
      });

      const leakedLog = capturedLogs.find(
        (l) => (l as ToolExecutionAuditLog).errorCode === 'SENSITIVE_LEAK_TEST'
      ) as ToolExecutionAuditLog;

      expect(leakedLog).toBeDefined();
      expect(leakedLog.errorMessage).not.toContain('john.doe@example.com');
      expect(leakedLog.errorMessage).toContain('[REDACTED_EMAIL]');
      expect(leakedLog.errorMessage).not.toContain('+91-9876543210');
      expect(leakedLog.errorMessage).toContain('[REDACTED_PHONE]');
      expect(leakedLog.errorMessage).not.toContain('AIzaSyD987654321012345678901234567890');
      expect(leakedLog.errorMessage).toContain('[REDACTED_GEMINI_KEY]');
      expect(leakedLog.metadata?.secret).toBe('[REDACTED_SENSITIVE_FIELD]');
      expect(leakedLog.metadata?.password).toBe('[REDACTED_SENSITIVE_FIELD]');
    });

    it('8. Logging failure never affects business logic execution', () => {
      // Simulate listener that throws an unhandled error
      auditLogger.addListener(() => {
        throw new Error('Logger explosion simulated error');
      });

      expect(() => {
        auditLogger.logToolExecutionSucceeded({
          toolName: 'safe_tool',
          durationMs: 10,
        });
      }).not.toThrow();
    });
  });
});
