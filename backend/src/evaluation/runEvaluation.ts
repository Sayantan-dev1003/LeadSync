import { runAgentEvaluation } from './evaluator';
import { formatEvaluationReportText } from './evaluation-metrics';

async function main() {
  const isLive = process.argv.includes('--live') || process.env.EVAL_LIVE === 'true';

  console.info(`Starting LeadSync Agent Reliability Evaluation... [Mode: ${isLive ? 'LIVE GEMINI' : 'DETERMINISTIC CI'}]`);

  try {
    const report = await runAgentEvaluation({ live: isLive });
    const formatted = formatEvaluationReportText(report);
    console.log('\n' + formatted + '\n');

    if (report.failed > 0) {
      console.error(`Evaluation finished with ${report.failed} failing scenario(s).`);
      process.exit(1);
    } else {
      console.info(`Evaluation passed successfully (${report.passed}/${report.totalScenarios} scenarios).`);
      process.exit(0);
    }
  } catch (err) {
    console.error('Fatal error during evaluation run:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
