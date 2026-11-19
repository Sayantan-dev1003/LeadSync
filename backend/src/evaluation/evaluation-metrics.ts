import {
  EvaluationMetrics,
  EvaluationReport,
  ScenarioExecutionResult,
} from './types';

/**
 * Calculates Metric 1: Successful Extraction Rate
 * Formula: (Successfully Extracted Expected Cases / Total Eligible Evaluation Cases) * 100
 * Also calculates full CSV success rate and individual row extraction rate.
 */
export function calculateExtractionRates(results: ScenarioExecutionResult[]): {
  successfulExtractionRate: number;
  csvSuccessRate: number;
  rowExtractionRate: number;
} {
  const extractionScenarios = results.filter((r) =>
    r.category === 'TOOL_SELECTION' || r.category === 'OUTPUT_VALIDATION'
  );

  if (extractionScenarios.length === 0) {
    return { successfulExtractionRate: 0, csvSuccessRate: 0, rowExtractionRate: 0 };
  }

  const passedCases = extractionScenarios.filter((r) => r.passed).length;
  const successfulExtractionRate = Number(
    ((passedCases / extractionScenarios.length) * 100).toFixed(1)
  );

  // CSV level
  const csvScenarios = results.filter((r) => r.category === 'TOOL_SELECTION');
  const csvPassed = csvScenarios.filter((r) => r.passed).length;
  const csvSuccessRate =
    csvScenarios.length > 0
      ? Number(((csvPassed / csvScenarios.length) * 100).toFixed(1))
      : 100;

  // Individual Row level
  let totalRows = 0;
  let extractedValidRows = 0;

  for (const r of extractionScenarios) {
    if (r.details?.totalRows) {
      totalRows += r.details.totalRows;
      extractedValidRows += r.details.validRowsExtracted ?? (r.passed ? r.details.totalRows : 0);
    }
  }

  const rowExtractionRate =
    totalRows > 0
      ? Number(((extractedValidRows / totalRows) * 100).toFixed(1))
      : 100;

  return {
    successfulExtractionRate,
    csvSuccessRate,
    rowExtractionRate,
  };
}

/**
 * Calculates Metric 2: Function-Call Accuracy
 * - Function selection accuracy rate = (Correct Function Selections / Total Selection Scenarios) * 100
 * - Function argument accuracy rate = (Correct Argument Fields / Total Evaluated Argument Fields) * 100
 */
export function calculateFunctionCallAccuracy(results: ScenarioExecutionResult[]): {
  functionSelectionAccuracy: number;
  functionArgumentAccuracy: number;
} {
  const selectionScenarios = results.filter((r) => r.category === 'TOOL_SELECTION');
  const correctSelections = selectionScenarios.filter(
    (r) => r.details?.toolSelectionCorrect === true || (r.passed && r.details?.toolSelectionCorrect !== false)
  ).length;

  const functionSelectionAccuracy =
    selectionScenarios.length > 0
      ? Number(((correctSelections / selectionScenarios.length) * 100).toFixed(1))
      : 100;

  const argScenarios = results.filter((r) => r.category === 'ARGUMENT_ACCURACY');
  let evaluatedFields = 0;
  let correctFields = 0;

  for (const r of argScenarios) {
    if (r.details?.argumentsEvaluated != null && r.details.argumentsEvaluated > 0) {
      evaluatedFields += r.details.argumentsEvaluated;
      correctFields += r.details.argumentsCorrect ?? (r.passed ? r.details.argumentsEvaluated : 0);
    } else {
      evaluatedFields += 1;
      if (r.passed) correctFields += 1;
    }
  }

  const functionArgumentAccuracy =
    evaluatedFields > 0
      ? Number(((correctFields / evaluatedFields) * 100).toFixed(1))
      : 100;

  return {
    functionSelectionAccuracy,
    functionArgumentAccuracy,
  };
}

/**
 * Calculates Metric 3: Schema Validation Pass Rate
 * Verifies both:
 * - Valid outputs are accepted
 * - Invalid outputs are correctly rejected
 * Formula: (Correctly Handled Validation Cases / Total Validation Cases) * 100
 */
export function calculateSchemaValidationPassRate(results: ScenarioExecutionResult[]): number {
  const valScenarios = results.filter((r) => r.category === 'OUTPUT_VALIDATION');
  if (valScenarios.length === 0) return 0;

  const correctDecisions = valScenarios.filter((r) => r.passed).length;
  return Number(((correctDecisions / valScenarios.length) * 100).toFixed(1));
}

/**
 * Calculates Metric 4: Failure Recovery Rate
 * Formula: (Successfully Recovered Transient Failures / Total Eligible Transient Failure Scenarios) * 100
 * Note: Permanent failures are strictly excluded from the recovery count numerator.
 */
export function calculateFailureRecoveryRate(results: ScenarioExecutionResult[]): number {
  const transientScenarios = results.filter(
    (r) => r.category === 'EXECUTION_RECOVERY' && r.details?.transientRecoverySuccessful !== undefined
  );

  if (transientScenarios.length === 0) {
    // Check if any scenario expected recovery
    const recoveryExpected = results.filter((r) => r.expectedResult === 'RECOVERED');
    if (recoveryExpected.length === 0) return 100;
    const recovered = recoveryExpected.filter((r) => r.passed).length;
    return Number(((recovered / recoveryExpected.length) * 100).toFixed(1));
  }

  const successfullyRecovered = transientScenarios.filter(
    (r) => r.details?.transientRecoverySuccessful === true
  ).length;

  return Number(((successfullyRecovered / transientScenarios.length) * 100).toFixed(1));
}

/**
 * Computes all 4 evaluation metrics from scenario execution results.
 */
export function computeMetrics(results: ScenarioExecutionResult[]): EvaluationMetrics {
  const { successfulExtractionRate, csvSuccessRate, rowExtractionRate } =
    calculateExtractionRates(results);
  const { functionSelectionAccuracy, functionArgumentAccuracy } =
    calculateFunctionCallAccuracy(results);
  const schemaValidationPassRate = calculateSchemaValidationPassRate(results);
  const failureRecoveryRate = calculateFailureRecoveryRate(results);

  return {
    successfulExtractionRate,
    csvSuccessRate,
    rowExtractionRate,
    functionSelectionAccuracy,
    functionArgumentAccuracy,
    schemaValidationPassRate,
    failureRecoveryRate,
  };
}

/**
 * Generates the complete EvaluationReport.
 */
export function buildEvaluationReport(
  scenarioResults: ScenarioExecutionResult[],
  durationMs: number,
  mode: 'deterministic' | 'live' = 'deterministic'
): EvaluationReport {
  const passed = scenarioResults.filter((r) => r.passed).length;
  const failed = scenarioResults.filter((r) => !r.passed).length;

  const failedScenarios = scenarioResults
    .filter((r) => !r.passed)
    .map((r) => ({
      scenarioId: r.scenarioId,
      failureReason: r.failureReason || 'Result did not match expected behavior',
      expectedResult: r.expectedResult,
      actualResult: r.actualResult,
    }));

  const metrics = computeMetrics(scenarioResults);

  return {
    totalScenarios: scenarioResults.length,
    passed,
    failed,
    metrics,
    scenarioResults,
    failedScenarios,
    executionDurationMs: durationMs,
    mode,
  };
}

/**
 * Renders the evaluation report into the standard readable text format.
 */
export function formatEvaluationReportText(report: EvaluationReport): string {
  const lines: string[] = [];

  lines.push('================================================================================');
  lines.push('                         AGENT RELIABILITY EVALUATION                           ');
  lines.push('================================================================================');
  lines.push('');
  lines.push(`Mode: ${report.mode.toUpperCase()} (Duration: ${report.executionDurationMs}ms)`);
  lines.push(`Total scenarios: ${report.totalScenarios}`);
  lines.push(`Passed: ${report.passed}`);
  lines.push(`Failed: ${report.failed}`);
  lines.push('');
  lines.push('Metrics:');
  lines.push(`- Successful Extraction Rate: ${report.metrics.successfulExtractionRate}% (CSV: ${report.metrics.csvSuccessRate}%, Individual Rows: ${report.metrics.rowExtractionRate}%)`);
  lines.push(`- Function Selection Accuracy: ${report.metrics.functionSelectionAccuracy}%`);
  lines.push(`- Function Argument Accuracy: ${report.metrics.functionArgumentAccuracy}%`);
  lines.push(`- Schema Validation Pass Rate: ${report.metrics.schemaValidationPassRate}%`);
  lines.push(`- Failure Recovery Rate: ${report.metrics.failureRecoveryRate}%`);
  lines.push('');
  lines.push('Failed Scenarios:');
  if (report.failedScenarios.length === 0) {
    lines.push('- (None - All evaluation scenarios passed)');
  } else {
    for (const f of report.failedScenarios) {
      lines.push(`- Scenario ID: ${f.scenarioId}`);
      lines.push(`  Failure reason: ${f.failureReason}`);
      lines.push(`  Expected result: ${f.expectedResult}`);
      lines.push(`  Actual result: ${f.actualResult}`);
    }
  }
  lines.push('================================================================================');

  return lines.join('\n');
}
