/**
 * types.ts - Shared type definitions for the eval harness.
 */

export interface GoldLabels {
  entities: Array<{ name: string; type: string }>;
  root_cause: string | null;
  fix_summary: string | null;
  services: string[];
  fact_count_expected: number;
  has_semantic_content: boolean;
  complexity: string;
  device: string;
  det_count: number;
  semantic_count: number;
}

export interface EvalCase {
  eval_case_id: string;
  artifact_id: string;
  gold_labels: GoldLabels;
  notes: string | null;
  source_type: string;
  created_at: Date;
}

export interface ExtractedData {
  entities: Array<{ name: string; type: string }>;
  facts: Array<{
    subject: string;
    predicate: string;
    object_value: any;
    assertion_class: string;
  }>;
  root_cause: string | null;
  fix_summary: string | null;
  services: string[];
  fact_count: number;
  det_count: number;
  semantic_count: number;
  assertion_class_distribution: Record<string, number>;
}

export interface EvalMetrics {
  entityPrecision: number;
  entityRecall: number;
  entityF1: number;
  factCount: { expected: number; actual: number; ratio: number };
  rootCauseMatch: boolean | null;
  fixSummaryMatch: boolean | null;
  assertionClassDistribution: Record<string, number>;
  servicePrecision: number;
  serviceRecall: number;
  serviceF1: number;
}

export interface CaseResult {
  eval_case_id: string;
  artifact_id: string;
  source_key: string;
  device: string;
  complexity: string;
  metrics: EvalMetrics;
  gold: GoldLabels;
  extracted: ExtractedData;
}

export interface AggregateMetrics {
  total_cases: number;
  avg_entity_precision: number;
  avg_entity_recall: number;
  avg_entity_f1: number;
  avg_fact_count_ratio: number;
  root_cause_detection_rate: number;
  fix_summary_detection_rate: number;
  avg_service_precision: number;
  avg_service_recall: number;
  avg_service_f1: number;
  assertion_class_totals: Record<string, number>;
  per_device: Record<string, {
    count: number;
    avg_entity_f1: number;
    avg_fact_ratio: number;
    root_cause_rate: number;
  }>;
  per_complexity: Record<string, {
    count: number;
    avg_entity_f1: number;
    avg_fact_ratio: number;
  }>;
}
