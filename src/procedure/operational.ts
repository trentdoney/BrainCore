import type postgres from "postgres";
import { config } from "../config";
import { isMissingLifecycleIntelligenceTable, lifecycleProcedureVisibleSql } from "./lifecycle-filter";

export interface ProcedureOperationalOptions {
  tenant?: string;
  query: string;
  scope?: string | null;
  limit?: number;
}

export interface NextStepOptions extends ProcedureOperationalOptions {
  completedSteps?: number;
}

export interface ProcedureStepEvidence {
  procedureId: string;
  procedureTitle: string;
  procedureSummary: string | null;
  scopePath: string | null;
  procedureSourceFactId: string | null;
  procedureEvidenceSegmentId: string | null;
  episodeOutcome: string | null;
  stepId: string;
  stepIndex: number;
  action: string;
  expectedResult: string | null;
  stepSourceFactId: string | null;
  stepEvidenceSegmentId: string | null;
  confidence: number | null;
}

const FAILED_OUTCOME_PATTERN = "(fail|failed|failure|unresolved|regress|regressed|unsuccessful|did not|error)";

function clampLimit(limit: number | undefined, max = 100): number {
  return Math.max(1, Math.min(limit ?? 20, max));
}

function mapStep(row: any): ProcedureStepEvidence {
  return {
    procedureId: String(row.procedure_id),
    procedureTitle: String(row.procedure_title),
    procedureSummary: row.procedure_summary ?? null,
    scopePath: row.scope_path ?? null,
    procedureSourceFactId: row.procedure_source_fact_id ?? null,
    procedureEvidenceSegmentId: row.procedure_evidence_segment_id ?? null,
    episodeOutcome: row.episode_outcome ?? null,
    stepId: String(row.step_id),
    stepIndex: Number(row.step_index),
    action: String(row.action),
    expectedResult: row.expected_result ?? null,
    stepSourceFactId: row.step_source_fact_id ?? null,
    stepEvidenceSegmentId: row.step_evidence_segment_id ?? null,
    confidence: row.confidence == null ? null : Number(row.confidence),
  };
}

export async function findNextProcedureSteps(
  sql: postgres.Sql,
  options: NextStepOptions,
): Promise<ProcedureStepEvidence[]> {
  const tenant = options.tenant ?? config.tenant;
  const query = options.query.trim();
  if (!query) return [];
  const completedSteps = Math.max(0, Math.trunc(options.completedSteps ?? 0));
  const limit = clampLimit(options.limit, 50);
  const pattern = `%${query}%`;

  const run = async (includeLifecycleFilter: boolean) => await sql`
    WITH matches AS (
      SELECT
        p.procedure_id,
        ts_rank(p.fts, plainto_tsquery('english', ${query})) AS rank
      FROM preserve.procedure p
      WHERE p.tenant = ${tenant}
        AND p.lifecycle_state != 'retired'
        ${lifecycleProcedureVisibleSql(sql, includeLifecycleFilter)}
        AND (${options.scope ?? null}::text IS NULL OR COALESCE(p.scope_path, '') LIKE (${options.scope ?? ""} || '%'))
        AND (
          p.fts @@ plainto_tsquery('english', ${query})
          OR p.title ILIKE ${pattern}
          OR p.summary ILIKE ${pattern}
        )
      ORDER BY rank DESC, p.confidence DESC, p.updated_at DESC
      LIMIT ${limit}
    )
    SELECT
      p.procedure_id::text,
      p.title AS procedure_title,
      p.summary AS procedure_summary,
      p.scope_path,
      p.source_fact_id::text AS procedure_source_fact_id,
      p.evidence_segment_id::text AS procedure_evidence_segment_id,
      ep.outcome AS episode_outcome,
      ps.procedure_step_id::text AS step_id,
      ps.step_index,
      ps.action,
      ps.expected_result,
      ps.source_fact_id::text AS step_source_fact_id,
      ps.evidence_segment_id::text AS step_evidence_segment_id,
      ps.confidence::float AS confidence,
      matches.rank
    FROM matches
    JOIN preserve.procedure p
      ON p.procedure_id = matches.procedure_id
     AND p.tenant = ${tenant}
    LEFT JOIN preserve.episode ep
      ON ep.episode_id = p.source_episode_id
     AND ep.tenant = ${tenant}
    JOIN LATERAL (
      SELECT *
      FROM preserve.procedure_step ps
      WHERE ps.tenant = ${tenant}
        AND ps.procedure_id = p.procedure_id
        AND ps.step_index > ${completedSteps}
      ORDER BY ps.step_index ASC
      LIMIT 1
    ) ps ON TRUE
    ORDER BY matches.rank DESC, p.confidence DESC, ps.step_index ASC
    LIMIT ${limit}
  `;
  let rows;
  try {
    rows = await run(true);
  } catch (error) {
    if (!isMissingLifecycleIntelligenceTable(error)) throw error;
    rows = await run(false);
  }
  return rows.map(mapStep);
}

export async function findTriedProcedureSteps(
  sql: postgres.Sql,
  options: ProcedureOperationalOptions,
): Promise<ProcedureStepEvidence[]> {
  const tenant = options.tenant ?? config.tenant;
  const query = options.query.trim();
  if (!query) return [];
  const limit = clampLimit(options.limit, 100);
  const pattern = `%${query}%`;

  const run = async (includeLifecycleFilter: boolean) => await sql`
    SELECT
      p.procedure_id::text,
      p.title AS procedure_title,
      p.summary AS procedure_summary,
      p.scope_path,
      p.source_fact_id::text AS procedure_source_fact_id,
      p.evidence_segment_id::text AS procedure_evidence_segment_id,
      ep.outcome AS episode_outcome,
      ps.procedure_step_id::text AS step_id,
      ps.step_index,
      ps.action,
      ps.expected_result,
      ps.source_fact_id::text AS step_source_fact_id,
      ps.evidence_segment_id::text AS step_evidence_segment_id,
      ps.confidence::float AS confidence
    FROM preserve.procedure p
    JOIN preserve.procedure_step ps
      ON ps.procedure_id = p.procedure_id
     AND ps.tenant = ${tenant}
    LEFT JOIN preserve.episode ep
      ON ep.episode_id = p.source_episode_id
     AND ep.tenant = ${tenant}
    WHERE p.tenant = ${tenant}
      AND p.lifecycle_state != 'retired'
      ${lifecycleProcedureVisibleSql(sql, includeLifecycleFilter)}
      AND (${options.scope ?? null}::text IS NULL OR COALESCE(p.scope_path, ps.scope_path, '') LIKE (${options.scope ?? ""} || '%'))
      AND (
        p.fts @@ plainto_tsquery('english', ${query})
        OR p.title ILIKE ${pattern}
        OR p.summary ILIKE ${pattern}
        OR ps.action ILIKE ${pattern}
        OR ps.expected_result ILIKE ${pattern}
      )
    ORDER BY p.updated_at DESC, p.confidence DESC, ps.step_index ASC
    LIMIT ${limit}
  `;
  let rows;
  try {
    rows = await run(true);
  } catch (error) {
    if (!isMissingLifecycleIntelligenceTable(error)) throw error;
    rows = await run(false);
  }
  return rows.map(mapStep);
}

export async function findFailedRemediationSteps(
  sql: postgres.Sql,
  options: ProcedureOperationalOptions,
): Promise<ProcedureStepEvidence[]> {
  const tenant = options.tenant ?? config.tenant;
  const query = options.query.trim();
  if (!query) return [];
  const limit = clampLimit(options.limit, 100);
  const pattern = `%${query}%`;

  const run = async (includeLifecycleFilter: boolean) => await sql`
    SELECT
      p.procedure_id::text,
      p.title AS procedure_title,
      p.summary AS procedure_summary,
      p.scope_path,
      p.source_fact_id::text AS procedure_source_fact_id,
      p.evidence_segment_id::text AS procedure_evidence_segment_id,
      ep.outcome AS episode_outcome,
      ps.procedure_step_id::text AS step_id,
      ps.step_index,
      ps.action,
      ps.expected_result,
      ps.source_fact_id::text AS step_source_fact_id,
      ps.evidence_segment_id::text AS step_evidence_segment_id,
      ps.confidence::float AS confidence
    FROM preserve.procedure p
    JOIN preserve.procedure_step ps
      ON ps.procedure_id = p.procedure_id
     AND ps.tenant = ${tenant}
    LEFT JOIN preserve.episode ep
      ON ep.episode_id = p.source_episode_id
     AND ep.tenant = ${tenant}
    WHERE p.tenant = ${tenant}
      AND p.lifecycle_state != 'retired'
      ${lifecycleProcedureVisibleSql(sql, includeLifecycleFilter)}
      AND (${options.scope ?? null}::text IS NULL OR COALESCE(p.scope_path, ps.scope_path, '') LIKE (${options.scope ?? ""} || '%'))
      AND (
        p.fts @@ plainto_tsquery('english', ${query})
        OR p.title ILIKE ${pattern}
        OR p.summary ILIKE ${pattern}
        OR ps.action ILIKE ${pattern}
        OR ps.expected_result ILIKE ${pattern}
      )
      AND (
        lower(COALESCE(ep.outcome, '')) ~ ${FAILED_OUTCOME_PATTERN}
        OR lower(COALESCE(p.summary, '')) ~ ${FAILED_OUTCOME_PATTERN}
        OR lower(COALESCE(ps.expected_result, '')) ~ ${FAILED_OUTCOME_PATTERN}
        OR lower(COALESCE(ps.step_json::text, '')) ~ ${FAILED_OUTCOME_PATTERN}
      )
    ORDER BY p.updated_at DESC, p.confidence DESC, ps.step_index ASC
    LIMIT ${limit}
  `;
  let rows;
  try {
    rows = await run(true);
  } catch (error) {
    if (!isMissingLifecycleIntelligenceTable(error)) throw error;
    rows = await run(false);
  }
  return rows.map(mapStep);
}
