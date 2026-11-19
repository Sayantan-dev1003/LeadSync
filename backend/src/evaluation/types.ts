export type EvaluationCategory =
  | 'TOOL_SELECTION'
  | 'ARGUMENT_ACCURACY'
  | 'OUTPUT_VALIDATION'
  | 'EXECUTION_RECOVERY';

export type ExpectedResult = 'SUCCESS' | 'REJECTED' | 'FAILED' | 'RECOVERED';

export interface EvaluationScenario {
  id: string;
  category: EvaluationCategory;
  name: string;
  description: string;
  input: unknown;
  expectedTool?: string | null;
  expectedArgs?: Record<string, unknown>;
  expectedResult: ExpectedResult;
  expectedBehavior: string;
  expectedRecovery?: boolean;
  isTransientFailure?: boolean;
  totalRows?: number;
  expectedValidRows?: number;
  tags?: string[];
}

export interface ScenarioExecutionResult {
  scenarioId: string;
  category: EvaluationCategory;
  name: string;
  passed: boolean;
  expectedResult: ExpectedResult;
  actualResult: ExpectedResult;
  failureReason?: string;
  durationMs: number;
  details?: {
    toolSelected?: string | null;
    toolSelectionCorrect?: boolean;
    argumentAccuracyScore?: number; // 0 to 1
    argumentsEvaluated?: number;
    argumentsCorrect?: number;
    schemaValidationCorrect?: boolean;
    transientRecoverySuccessful?: boolean;
    totalRows?: number;
    validRowsExtracted?: number;
    actualError?: string;
  };
}

export interface EvaluationMetrics {
  successfulExtractionRate: number;
  csvSuccessRate: number;
  rowExtractionRate: number;
  functionSelectionAccuracy: number;
  functionArgumentAccuracy: number;
  schemaValidationPassRate: number;
  failureRecoveryRate: number;
}

export interface EvaluationReport {
  totalScenarios: number;
  passed: number;
  failed: number;
  metrics: EvaluationMetrics;
  scenarioResults: ScenarioExecutionResult[];
  failedScenarios: Array<{
    scenarioId: string;
    failureReason: string;
    expectedResult: string;
    actualResult: string;
  }>;
  executionDurationMs: number;
  mode: 'deterministic' | 'live';
}
