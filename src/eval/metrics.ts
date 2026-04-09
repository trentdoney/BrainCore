/**
 * metrics.ts - Compute precision, recall, F1, and other eval metrics.
 */

import type { GoldLabels, ExtractedData, EvalMetrics } from "./types";

/**
 * Compute set-based precision, recall, F1 for string sets.
 * Uses lowercased comparison for robustness.
 */
function setMetrics(
  goldSet: string[],
  extractedSet: string[],
): { precision: number; recall: number; f1: number } {
  const gold = new Set(goldSet.map((s) => s.toLowerCase().trim()));
  const extracted = new Set(extractedSet.map((s) => s.toLowerCase().trim()));

  if (gold.size === 0 && extracted.size === 0) {
    return { precision: 1.0, recall: 1.0, f1: 1.0 };
  }
  if (extracted.size === 0) {
    return { precision: 0, recall: 0, f1: 0 };
  }
  if (gold.size === 0) {
    // No gold entities but we extracted some - precision undefined, treat as 0
    return { precision: 0, recall: 1.0, f1: 0 };
  }

  let truePositives = 0;
  for (const item of extracted) {
    if (gold.has(item)) truePositives++;
  }

  const precision = truePositives / extracted.size;
  const recall = truePositives / gold.size;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1 };
}

/**
 * Check if two text strings match semantically (simple containment check).
 * Returns true if either string contains the other, or if they share >60% words.
 */
function textMatch(gold: string | null, extracted: string | null): boolean | null {
  if (gold === null && extracted === null) return null;
  if (gold === null || extracted === null) return false;

  const g = gold.toLowerCase().trim();
  const e = extracted.toLowerCase().trim();

  // Exact match
  if (g === e) return true;

  // Containment
  if (g.includes(e) || e.includes(g)) return true;

  // Word overlap check (>60% shared words)
  const gWords = new Set(g.split(/\s+/).filter((w) => w.length > 3));
  const eWords = new Set(e.split(/\s+/).filter((w) => w.length > 3));

  if (gWords.size === 0 || eWords.size === 0) return false;

  let shared = 0;
  for (const w of gWords) {
    if (eWords.has(w)) shared++;
  }

  const overlapRatio = shared / Math.max(gWords.size, eWords.size);
  return overlapRatio > 0.6;
}

/**
 * Compute all eval metrics for a single case by comparing gold labels to extracted data.
 */
export function computeMetrics(gold: GoldLabels, extracted: ExtractedData): EvalMetrics {
  // Entity comparison: compare by name only (type matching is secondary)
  const goldEntityNames = gold.entities.map((e) => e.name);
  const extractedEntityNames = extracted.entities.map((e) => e.name);
  const entityMetrics = setMetrics(goldEntityNames, extractedEntityNames);

  // Service comparison
  const serviceMetrics = setMetrics(gold.services || [], extracted.services || []);

  // Fact count ratio
  const factRatio =
    gold.fact_count_expected > 0
      ? extracted.fact_count / gold.fact_count_expected
      : extracted.fact_count === 0
        ? 1.0
        : 0;

  // Root cause match
  const rootCauseGold = typeof gold.root_cause === 'string' ? gold.root_cause : null;
  const rootCauseMatch = textMatch(rootCauseGold, extracted.root_cause);

  // Fix summary match
  const fixSummaryGold = typeof gold.fix_summary === 'string' ? gold.fix_summary : null;
  const fixSummaryMatch = textMatch(fixSummaryGold, extracted.fix_summary);

  return {
    entityPrecision: entityMetrics.precision,
    entityRecall: entityMetrics.recall,
    entityF1: entityMetrics.f1,
    factCount: {
      expected: gold.fact_count_expected,
      actual: extracted.fact_count,
      ratio: factRatio,
    },
    rootCauseMatch,
    fixSummaryMatch,
    assertionClassDistribution: extracted.assertion_class_distribution,
    servicePrecision: serviceMetrics.precision,
    serviceRecall: serviceMetrics.recall,
    serviceF1: serviceMetrics.f1,
  };
}
