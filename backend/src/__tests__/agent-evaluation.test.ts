import { EVALUATION_SCENARIOS } from '../evaluation/scenarios';
import {
  calculateExtractionRates,
  calculateFunctionCallAccuracy,
  calculateSchemaValidationPassRate,
  calculateFailureRecoveryRate,
  computeMetrics,
  buildEvaluationReport,
  formatEvaluationReportText,
} from '../evaluation/evaluation-metrics';
import { executeScenario, runAgentEvaluation } from '../evaluation/evaluator';
import { EvaluationScenario, ScenarioExecutionResult } from '../evaluation/types';

describe('Agent Reliability Evaluation Framework', () => {
  describe('Dataset & Scenario Definitions', () => {
    it('loads all 26 evaluation scenarios across 4 required categories', () => {
      expect(EVALUATION_SCENARIOS.length).toBeGreaterThanOrEqual(15);
      expect(EVALUATION_SCENARIOS.length).toBe(26);

      const categories = new Set(EVALUATION_SCENARIOS.map((s) => s.category));
      expect(categories).toContain('TOOL_SELECTION');
      expect(categories).toContain('ARGUMENT_ACCURACY');
      expect(categories).toContain('OUTPUT_VALIDATION');
      expect(categories).toContain('EXECUTION_RECOVERY');
    });

    it('ensures each scenario contains unique id, description, and expected outcomes', () => {
      const ids = new Set<string>();

      for (const scenario of EVALUATION_SCENARIOS) {
        expect(ids.has(scenario.id)).toBe(false);
        ids.add(scenario.id);

        expect(typeof scenario.id).toBe('string');
        expect(scenario.id.length).toBeGreaterThan(0);
        expect(typeof scenario.name).toBe('string');
        expect(typeof scenario.description).toBe('string');
        expect(scenario.expectedResult).toMatch(/^(SUCCESS|REJECTED|FAILED|RECOVERED)$/);
        expect(typeof scenario.expectedBehavior).toBe('string');
      }
    });

    it('contains all 6 required Tool Selection scenarios', () => {
      const selectionScenarios = EVALUATION_SCENARIOS.filter((s) => s.category === 'TOOL_SELECTION');
      expect(selectionScenarios).toHaveLength(6);

      const names = selectionScenarios.map((s) => s.name.toLowerCase());
      expect(names.some((n) => n.includes('straightforward'))).toBe(true);
      expect(names.some((n) => n.includes('inconsistent') || n.includes('unfamiliar'))).toBe(true);
      expect(names.some((n) => n.includes('reordered'))).toBe(true);
      expect(names.some((n) => n.includes('synonymous'))).toBe(true);
      expect(names.some((n) => n.includes('ambiguous'))).toBe(true);
      expect(names.some((n) => n.includes('unmappable'))).toBe(true);
    });

    it('contains all 6 required Argument Accuracy scenarios', () => {
      const argScenarios = EVALUATION_SCENARIOS.filter((s) => s.category === 'ARGUMENT_ACCURACY');
      expect(argScenarios).toHaveLength(6);

      const names = argScenarios.map((s) => s.name.toLowerCase());
      expect(names.some((n) => n.includes('correctly structured'))).toBe(true);
      expect(names.some((n) => n.includes('missing mandatory'))).toBe(true);
      expect(names.some((n) => n.includes('incorrect argument type'))).toBe(true);
      expect(names.some((n) => n.includes('invalid crm target'))).toBe(true);
      expect(names.some((n) => n.includes('unexpected additional'))).toBe(true);
      expect(names.some((n) => n.includes('empty or malformed'))).toBe(true);
    });

    it('contains all 6 required Output Validation scenarios', () => {
      const valScenarios = EVALUATION_SCENARIOS.filter((s) => s.category === 'OUTPUT_VALIDATION');
      expect(valScenarios).toHaveLength(6);

      const names = valScenarios.map((s) => s.name.toLowerCase());
      expect(names.some((n) => n.includes('valid structured'))).toBe(true);
      expect(names.some((n) => n.includes('malformed json'))).toBe(true);
      expect(names.some((n) => n.includes('missing mandatory contact info') || n.includes('skip'))).toBe(true);
      expect(names.some((n) => n.includes('invalid email'))).toBe(true);
      expect(names.some((n) => n.includes('invalid mobile'))).toBe(true);
      expect(names.some((n) => n.includes('unexpected additional fields'))).toBe(true);
    });

    it('contains all 8 required Tool Execution and Recovery scenarios', () => {
      const recScenarios = EVALUATION_SCENARIOS.filter((s) => s.category === 'EXECUTION_RECOVERY');
      expect(recScenarios).toHaveLength(8);

      const names = recScenarios.map((s) => s.name.toLowerCase());
      expect(names.some((n) => n.includes('successful tool execution'))).toBe(true);
      expect(names.some((n) => n.includes('transient failure'))).toBe(true);
      expect(names.some((n) => n.includes('permanent tool execution failure'))).toBe(true);
      expect(names.some((n) => n.includes('timeout'))).toBe(true);
      expect(names.some((n) => n.includes('unknown function name'))).toBe(true);
      expect(names.some((n) => n.includes('maximum orchestration'))).toBe(true);
      expect(names.some((n) => n.includes('unauthorized'))).toBe(true);
      expect(names.some((n) => n.includes('human approval boundary'))).toBe(true);
    });
  });

  describe('Metric Calculation Mathematics', () => {
    it('calculates Metric 1: Successful Extraction Rate with distinction between CSV and rows', () => {
      const mockResults: ScenarioExecutionResult[] = [
        {
          scenarioId: 'S1',
          category: 'TOOL_SELECTION',
          name: 'CSV 1',
          passed: true,
          expectedResult: 'SUCCESS',
          actualResult: 'SUCCESS',
          durationMs: 10,
          details: { totalRows: 10, validRowsExtracted: 8 },
        },
        {
          scenarioId: 'S2',
          category: 'TOOL_SELECTION',
          name: 'CSV 2',
          passed: false,
          expectedResult: 'SUCCESS',
          actualResult: 'FAILED',
          durationMs: 10,
          details: { totalRows: 5, validRowsExtracted: 0 },
        },
        {
          scenarioId: 'S3',
          category: 'OUTPUT_VALIDATION',
          name: 'Row 1',
          passed: true,
          expectedResult: 'SUCCESS',
          actualResult: 'SUCCESS',
          durationMs: 10,
          details: { totalRows: 1, validRowsExtracted: 1 },
        },
      ];

      const metrics = calculateExtractionRates(mockResults);
      // 2 passed out of 3 total extraction scenarios = 66.7%
      expect(metrics.successfulExtractionRate).toBe(66.7);
      // 1 passed out of 2 CSV scenarios = 50.0%
      expect(metrics.csvSuccessRate).toBe(50.0);
      // (8 + 0 + 1) / (10 + 5 + 1) = 9 / 16 = 56.3%
      expect(metrics.rowExtractionRate).toBe(56.3);
    });

    it('calculates Metric 2: Function-Call Accuracy (selection and field-level arguments)', () => {
      const mockResults: ScenarioExecutionResult[] = [
        {
          scenarioId: 'S1',
          category: 'TOOL_SELECTION',
          name: 'Tool Sel 1',
          passed: true,
          expectedResult: 'SUCCESS',
          actualResult: 'SUCCESS',
          durationMs: 10,
          details: { toolSelectionCorrect: true },
        },
        {
          scenarioId: 'S2',
          category: 'TOOL_SELECTION',
          name: 'Tool Sel 2',
          passed: false,
          expectedResult: 'SUCCESS',
          actualResult: 'FAILED',
          durationMs: 10,
          details: { toolSelectionCorrect: false },
        },
        {
          scenarioId: 'S3',
          category: 'ARGUMENT_ACCURACY',
          name: 'Arg Test 1',
          passed: true,
          expectedResult: 'SUCCESS',
          actualResult: 'SUCCESS',
          durationMs: 10,
          details: { argumentsEvaluated: 4, argumentsCorrect: 4 },
        },
        {
          scenarioId: 'S4',
          category: 'ARGUMENT_ACCURACY',
          name: 'Arg Test 2',
          passed: false,
          expectedResult: 'SUCCESS',
          actualResult: 'REJECTED',
          durationMs: 10,
          details: { argumentsEvaluated: 4, argumentsCorrect: 2 },
        },
      ];

      const metrics = calculateFunctionCallAccuracy(mockResults);
      // Selection: 1 correct out of 2 = 50%
      expect(metrics.functionSelectionAccuracy).toBe(50.0);
      // Argument: (4 + 2) / (4 + 4) = 6 / 8 = 75.0%
      expect(metrics.functionArgumentAccuracy).toBe(75.0);
    });

    it('calculates Metric 3: Schema Validation Pass Rate (both valid accepted & invalid rejected)', () => {
      const mockResults: ScenarioExecutionResult[] = [
        {
          scenarioId: 'S1',
          category: 'OUTPUT_VALIDATION',
          name: 'Valid Accepted',
          passed: true, // Correctly accepted
          expectedResult: 'SUCCESS',
          actualResult: 'SUCCESS',
          durationMs: 5,
        },
        {
          scenarioId: 'S2',
          category: 'OUTPUT_VALIDATION',
          name: 'Invalid Rejected',
          passed: true, // Correctly rejected
          expectedResult: 'REJECTED',
          actualResult: 'REJECTED',
          durationMs: 5,
        },
        {
          scenarioId: 'S3',
          category: 'OUTPUT_VALIDATION',
          name: 'Invalid Erroneously Accepted',
          passed: false, // Incorrectly accepted
          expectedResult: 'REJECTED',
          actualResult: 'SUCCESS',
          durationMs: 5,
        },
        {
          scenarioId: 'S4',
          category: 'OUTPUT_VALIDATION',
          name: 'Valid Erroneously Rejected',
          passed: false, // Incorrectly rejected
          expectedResult: 'SUCCESS',
          actualResult: 'REJECTED',
          durationMs: 5,
        },
      ];

      const passRate = calculateSchemaValidationPassRate(mockResults);
      // 2 correct decisions out of 4 = 50.0%
      expect(passRate).toBe(50.0);
    });

    it('calculates Metric 4: Failure Recovery Rate (excludes permanent failures from numerator)', () => {
      const mockResults: ScenarioExecutionResult[] = [
        {
          scenarioId: 'REC-1',
          category: 'EXECUTION_RECOVERY',
          name: 'Transient Glitch 1',
          passed: true,
          expectedResult: 'RECOVERED',
          actualResult: 'RECOVERED',
          durationMs: 10,
          details: { transientRecoverySuccessful: true },
        },
        {
          scenarioId: 'REC-2',
          category: 'EXECUTION_RECOVERY',
          name: 'Transient Glitch 2',
          passed: false,
          expectedResult: 'RECOVERED',
          actualResult: 'FAILED',
          durationMs: 10,
          details: { transientRecoverySuccessful: false },
        },
      ];

      const recoveryRate = calculateFailureRecoveryRate(mockResults);
      // 1 successfully recovered out of 2 eligible transient scenarios = 50.0%
      expect(recoveryRate).toBe(50.0);
    });

    it('handles empty evaluation dataset gracefully without division by zero', () => {
      const emptyMetrics = computeMetrics([]);
      expect(emptyMetrics.successfulExtractionRate).toBe(0);
      expect(emptyMetrics.functionSelectionAccuracy).toBe(100);
      expect(emptyMetrics.functionArgumentAccuracy).toBe(100);
      expect(emptyMetrics.schemaValidationPassRate).toBe(0);
      expect(emptyMetrics.failureRecoveryRate).toBe(100);

      const report = buildEvaluationReport([], 0);
      expect(report.totalScenarios).toBe(0);
      expect(report.passed).toBe(0);
      expect(report.failed).toBe(0);
      expect(report.failedScenarios).toEqual([]);
    });
  });

  describe('Scenario Execution & Reporting', () => {
    it('executes all 26 scenarios deterministically with 100% pass rate in CI mode', async () => {
      const report = await runAgentEvaluation();

      expect(report.totalScenarios).toBe(26);
      expect(report.passed).toBe(26);
      expect(report.failed).toBe(0);
      expect(report.failedScenarios).toHaveLength(0);

      // Verify all metrics
      expect(report.metrics.successfulExtractionRate).toBe(100);
      expect(report.metrics.functionSelectionAccuracy).toBe(100);
      expect(report.metrics.functionArgumentAccuracy).toBe(100);
      expect(report.metrics.schemaValidationPassRate).toBe(100);
      expect(report.metrics.failureRecoveryRate).toBe(100);
    });

    it('reports failure accurately when a scenario fails', async () => {
      const failingScenario: EvaluationScenario = {
        id: 'SCN-FAIL-TEST',
        category: 'ARGUMENT_ACCURACY',
        name: 'Simulated Failing Scenario',
        description: 'Deliberately expects invalid tool name to succeed',
        input: {
          toolName: 'non_existent_tool_123',
          args: {},
          availableHeaders: [],
        },
        expectedResult: 'SUCCESS', // Will actually be REJECTED!
        expectedBehavior: 'Expects success but tool is unknown',
      };

      const result = await executeScenario(failingScenario);
      expect(result.passed).toBe(false);
      expect(result.actualResult).toBe('REJECTED');
      expect(result.expectedResult).toBe('SUCCESS');
      expect(result.failureReason).toBeDefined();

      const report = buildEvaluationReport([result], 15);
      expect(report.totalScenarios).toBe(1);
      expect(report.passed).toBe(0);
      expect(report.failed).toBe(1);
      expect(report.failedScenarios).toHaveLength(1);
      expect(report.failedScenarios[0].scenarioId).toBe('SCN-FAIL-TEST');

      const text = formatEvaluationReportText(report);
      expect(text).toContain('Failed: 1');
      expect(text).toContain('SCN-FAIL-TEST');
    });

    it('formats textual report adhering to the required structure', async () => {
      const report = await runAgentEvaluation();
      const text = formatEvaluationReportText(report);

      expect(text).toContain('AGENT RELIABILITY EVALUATION');
      expect(text).toContain('Total scenarios: 26');
      expect(text).toContain('Passed: 26');
      expect(text).toContain('Failed: 0');
      expect(text).toContain('Successful Extraction Rate:');
      expect(text).toContain('Function Selection Accuracy:');
      expect(text).toContain('Function Argument Accuracy:');
      expect(text).toContain('Schema Validation Pass Rate:');
      expect(text).toContain('Failure Recovery Rate:');
      expect(text).toContain('Failed Scenarios:');
      expect(text).toContain('(None - All evaluation scenarios passed)');
    });
  });
});
