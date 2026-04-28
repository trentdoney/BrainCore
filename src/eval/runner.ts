/**
 * runner.ts - Run eval across all gold set cases and compute aggregate metrics.
 */

import type postgres from "postgres";
import type { AggregateMetrics, CaseResult, EvalMetrics } from "./types";
import { loadGoldSet, compareExtraction } from "./gold";
import { computeMetrics } from "./metrics";

/**
 * Run evaluation on all gold set cases.
 * Returns aggregate metrics and per-case results.
 */
export async function runEval(sql: postgres.Sql): Promise<{
  metrics: AggregateMetrics;
  cases: CaseResult[];
}> {
  const goldSet = await loadGoldSet(sql);
  console.log(`  Loaded ${goldSet.length} gold set cases.`);

  const cases: CaseResult[] = [];

  for (const evalCase of goldSet) {
    // Get source_key for display
    const [artifact] = await sql`
      SELECT source_key FROM preserve.artifact
      WHERE artifact_id = ${evalCase.artifact_id}::uuid
    `;

    const extracted = await compareExtraction(evalCase.artifact_id, sql);
    const metrics = computeMetrics(evalCase.gold_labels, extracted);

    cases.push({
      eval_case_id: evalCase.eval_case_id,
      artifact_id: evalCase.artifact_id,
      source_key: artifact?.source_key || 'unknown',
      device: evalCase.gold_labels.device,
      complexity: evalCase.gold_labels.complexity,
      metrics,
      gold: evalCase.gold_labels,
      extracted,
    });
  }

  const metrics = computeAggregate(cases);

  return { metrics, cases };
}

/**
 * Compute aggregate metrics from individual case results.
 */
function computeAggregate(cases: CaseResult[]): AggregateMetrics {
  const n = cases.length;
  if (n === 0) {
    return {
      total_cases: 0,
      avg_entity_precision: 0,
      avg_entity_recall: 0,
      avg_entity_f1: 0,
      avg_fact_count_ratio: 0,
      root_cause_detection_rate: 0,
      fix_summary_detection_rate: 0,
      avg_service_precision: 0,
      avg_service_recall: 0,
      avg_service_f1: 0,
      assertion_class_totals: {},
      per_device: {},
      per_complexity: {},
    };
  }

  // Averages
  const avgEntityPrecision = cases.reduce((s, c) => s + c.metrics.entityPrecision, 0) / n;
  const avgEntityRecall = cases.reduce((s, c) => s + c.metrics.entityRecall, 0) / n;
  const avgEntityF1 = cases.reduce((s, c) => s + c.metrics.entityF1, 0) / n;
  const avgFactRatio = cases.reduce((s, c) => s + c.metrics.factCount.ratio, 0) / n;
  const avgServicePrecision = cases.reduce((s, c) => s + c.metrics.servicePrecision, 0) / n;
  const avgServiceRecall = cases.reduce((s, c) => s + c.metrics.serviceRecall, 0) / n;
  const avgServiceF1 = cases.reduce((s, c) => s + c.metrics.serviceF1, 0) / n;

  // Root cause detection rate (among cases that have a gold root cause)
  const casesWithRootCause = cases.filter((c) => c.metrics.rootCauseMatch !== null);
  const rootCauseRate =
    casesWithRootCause.length > 0
      ? casesWithRootCause.filter((c) => c.metrics.rootCauseMatch === true).length / casesWithRootCause.length
      : 0;

  // Fix summary detection rate
  const casesWithFixSummary = cases.filter((c) => c.metrics.fixSummaryMatch !== null);
  const fixSummaryRate =
    casesWithFixSummary.length > 0
      ? casesWithFixSummary.filter((c) => c.metrics.fixSummaryMatch === true).length / casesWithFixSummary.length
      : 0;

  // Assertion class totals
  const classDistTotals: Record<string, number> = {};
  for (const c of cases) {
    for (const [cls, count] of Object.entries(c.metrics.assertionClassDistribution)) {
      classDistTotals[cls] = (classDistTotals[cls] || 0) + count;
    }
  }

  // Per-device breakdown
  const perDevice: AggregateMetrics['per_device'] = {};
  const deviceGroups = groupBy(cases, (c) => c.device);
  for (const [device, deviceCases] of Object.entries(deviceGroups)) {
    const dn = deviceCases.length;
    const deviceRootCauseCases = deviceCases.filter((c) => c.metrics.rootCauseMatch !== null);
    perDevice[device] = {
      count: dn,
      avg_entity_f1: deviceCases.reduce((s, c) => s + c.metrics.entityF1, 0) / dn,
      avg_fact_ratio: deviceCases.reduce((s, c) => s + c.metrics.factCount.ratio, 0) / dn,
      root_cause_rate:
        deviceRootCauseCases.length > 0
          ? deviceRootCauseCases.filter((c) => c.metrics.rootCauseMatch === true).length / deviceRootCauseCases.length
          : 0,
    };
  }

  // Per-complexity breakdown
  const perComplexity: AggregateMetrics['per_complexity'] = {};
  const complexityGroups = groupBy(cases, (c) => c.complexity);
  for (const [complexity, complexCases] of Object.entries(complexityGroups)) {
    const cn = complexCases.length;
    perComplexity[complexity] = {
      count: cn,
      avg_entity_f1: complexCases.reduce((s, c) => s + c.metrics.entityF1, 0) / cn,
      avg_fact_ratio: complexCases.reduce((s, c) => s + c.metrics.factCount.ratio, 0) / cn,
    };
  }

  return {
    total_cases: n,
    avg_entity_precision: avgEntityPrecision,
    avg_entity_recall: avgEntityRecall,
    avg_entity_f1: avgEntityF1,
    avg_fact_count_ratio: avgFactRatio,
    root_cause_detection_rate: rootCauseRate,
    fix_summary_detection_rate: fixSummaryRate,
    avg_service_precision: avgServicePrecision,
    avg_service_recall: avgServiceRecall,
    avg_service_f1: avgServiceF1,
    assertion_class_totals: classDistTotals,
    per_device: perDevice,
    per_complexity: perComplexity,
  };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

/**
 * Print a formatted eval report to stdout.
 */
export function printReport(metrics: AggregateMetrics, cases: CaseResult[]): void {
  console.log('\n========================================');
  console.log('  BrainCore eval report');
  console.log('========================================\n');

  console.log(`Total gold set cases: ${metrics.total_cases}\n`);

  console.log('--- Overall Metrics ---');
  console.log(`  Entity Precision:        ${(metrics.avg_entity_precision * 100).toFixed(1)}%`);
  console.log(`  Entity Recall:           ${(metrics.avg_entity_recall * 100).toFixed(1)}%`);
  console.log(`  Entity F1:               ${(metrics.avg_entity_f1 * 100).toFixed(1)}%`);
  console.log(`  Service Precision:       ${(metrics.avg_service_precision * 100).toFixed(1)}%`);
  console.log(`  Service Recall:          ${(metrics.avg_service_recall * 100).toFixed(1)}%`);
  console.log(`  Service F1:              ${(metrics.avg_service_f1 * 100).toFixed(1)}%`);
  console.log(`  Fact Count Ratio (avg):  ${metrics.avg_fact_count_ratio.toFixed(3)}`);
  console.log(`  Root Cause Detection:    ${(metrics.root_cause_detection_rate * 100).toFixed(1)}%`);
  console.log(`  Fix Summary Detection:   ${(metrics.fix_summary_detection_rate * 100).toFixed(1)}%`);

  console.log('\n--- Assertion Class Distribution ---');
  for (const [cls, count] of Object.entries(metrics.assertion_class_totals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${count}`);
  }

  console.log('\n--- Per-Device Breakdown ---');
  for (const [device, stats] of Object.entries(metrics.per_device).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${device} (n=${stats.count}): Entity F1=${(stats.avg_entity_f1 * 100).toFixed(1)}%, Fact Ratio=${stats.avg_fact_ratio.toFixed(3)}, Root Cause=${(stats.root_cause_rate * 100).toFixed(1)}%`);
  }

  console.log('\n--- Per-Complexity Breakdown ---');
  for (const [complexity, stats] of Object.entries(metrics.per_complexity).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${complexity} (n=${stats.count}): Entity F1=${(stats.avg_entity_f1 * 100).toFixed(1)}%, Fact Ratio=${stats.avg_fact_ratio.toFixed(3)}`);
  }

  // Show worst 5 cases by entity F1
  const sorted = [...cases].sort((a, b) => a.metrics.entityF1 - b.metrics.entityF1);
  console.log('\n--- Bottom 5 Cases (by Entity F1) ---');
  for (const c of sorted.slice(0, 5)) {
    console.log(`  [${c.device}/${c.complexity}] ${c.source_key}`);
    console.log(`    Entity F1=${(c.metrics.entityF1 * 100).toFixed(1)}%, Facts: ${c.metrics.factCount.actual}/${c.metrics.factCount.expected}, Root Cause: ${c.metrics.rootCauseMatch ?? 'n/a'}`);
  }

  // Show top 5 cases by entity F1
  console.log('\n--- Top 5 Cases (by Entity F1) ---');
  for (const c of sorted.slice(-5).reverse()) {
    console.log(`  [${c.device}/${c.complexity}] ${c.source_key}`);
    console.log(`    Entity F1=${(c.metrics.entityF1 * 100).toFixed(1)}%, Facts: ${c.metrics.factCount.actual}/${c.metrics.factCount.expected}, Root Cause: ${c.metrics.rootCauseMatch ?? 'n/a'}`);
  }

  console.log('\n========================================');
  console.log('  END REPORT');
  console.log('========================================\n');
}

/**
 * Store eval run results in the database.
 */
export async function storeRun(
  sql: postgres.Sql,
  metrics: AggregateMetrics,
  cases: CaseResult[],
): Promise<string> {
  const results = cases.map((c) => ({
    eval_case_id: c.eval_case_id,
    source_key: c.source_key,
    device: c.device,
    complexity: c.complexity,
    metrics: c.metrics,
  }));
  const [row] = await sql`
    INSERT INTO preserve.eval_run (
      pipeline_version, model_name, prompt_version, results, metrics
    ) VALUES (
      '0.1.0',
      'deterministic+semantic',
      'incident-v1',
      ${sql.json(results as any)},
      ${sql.json(metrics as any)}
    )
    RETURNING eval_run_id
  `;
  return row.eval_run_id;
}
