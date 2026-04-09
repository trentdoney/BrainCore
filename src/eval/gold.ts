/**
 * gold.ts - Load gold set from preserve.eval_case and compare extractions.
 */

import type postgres from "postgres";
import type { EvalCase, ExtractedData, GoldLabels } from "./types";

/**
 * Load all gold set eval cases from the database.
 */
export async function loadGoldSet(sql: postgres.Sql): Promise<EvalCase[]> {
  const rows = await sql`
    SELECT ec.eval_case_id, ec.artifact_id, ec.gold_labels, ec.notes, ec.source_type, ec.created_at
    FROM preserve.eval_case ec
    ORDER BY ec.created_at ASC
  `;

  return rows.map((r: any) => ({
    eval_case_id: r.eval_case_id,
    artifact_id: r.artifact_id,
    gold_labels: r.gold_labels as GoldLabels,
    notes: r.notes,
    source_type: r.source_type,
    created_at: r.created_at,
  }));
}

/**
 * Extract actual data from the database for a given artifact, to compare against gold labels.
 */
export async function compareExtraction(artifactId: string, sql: postgres.Sql): Promise<ExtractedData> {
  // Get entities involved in this artifact's facts
  const entityRows = await sql`
    SELECT DISTINCT e.canonical_name as name, e.entity_type::text as type
    FROM preserve.fact f
    JOIN preserve.extraction_run er ON f.created_run_id = er.run_id
    JOIN preserve.entity e ON (f.subject_entity_id = e.entity_id OR f.object_entity_id = e.entity_id)
    WHERE er.artifact_id = ${artifactId}::uuid
    AND e.entity_type IN ('device', 'service', 'config_item')
  `;

  // Get all facts for this artifact
  const factRows = await sql`
    SELECT
      se.canonical_name as subject,
      f.predicate,
      f.object_value,
      f.assertion_class::text
    FROM preserve.fact f
    JOIN preserve.extraction_run er ON f.created_run_id = er.run_id
    JOIN preserve.entity se ON f.subject_entity_id = se.entity_id
    WHERE er.artifact_id = ${artifactId}::uuid
  `;

  // Get services
  const serviceRows = await sql`
    SELECT DISTINCT e.canonical_name as name
    FROM preserve.fact f
    JOIN preserve.extraction_run er ON f.created_run_id = er.run_id
    JOIN preserve.entity e ON (f.subject_entity_id = e.entity_id OR f.object_entity_id = e.entity_id)
    WHERE er.artifact_id = ${artifactId}::uuid
    AND e.entity_type = 'service'
  `;

  // Extract root_cause and fix_summary from deterministic facts
  const rootCauseFact = factRows.find(
    (f: any) => f.predicate === 'root_cause' && f.assertion_class === 'deterministic'
  );
  const fixSummaryFact = factRows.find(
    (f: any) => f.predicate === 'fix_summary' && f.assertion_class === 'deterministic'
  );

  // Compute assertion class distribution
  const distribution: Record<string, number> = {};
  for (const f of factRows) {
    const cls = f.assertion_class as string;
    distribution[cls] = (distribution[cls] || 0) + 1;
  }

  const detCount = distribution['deterministic'] || 0;
  const semCount = distribution['single_source_llm'] || 0;

  return {
    entities: entityRows.map((r: any) => ({ name: r.name, type: r.type })),
    facts: factRows.map((f: any) => ({
      subject: f.subject,
      predicate: f.predicate,
      object_value: f.object_value,
      assertion_class: f.assertion_class,
    })),
    root_cause: rootCauseFact ? String(rootCauseFact.object_value).replace(/^"|"$/g, '') : null,
    fix_summary: fixSummaryFact ? String(fixSummaryFact.object_value).replace(/^"|"$/g, '') : null,
    services: serviceRows.map((r: any) => r.name),
    fact_count: factRows.length,
    det_count: detCount,
    semantic_count: semCount,
    assertion_class_distribution: distribution,
  };
}
