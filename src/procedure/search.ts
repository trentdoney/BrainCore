import type postgres from "postgres";
import { config } from "../config";
import { isMissingLifecycleIntelligenceTable, lifecycleProcedureVisibleSql } from "./lifecycle-filter";

export interface ProcedureSearchOptions {
  tenant?: string;
  query: string;
  scope?: string;
  limit?: number;
}

export interface ProcedureSearchResult {
  procedureId: string;
  title: string;
  summary: string | null;
  confidence: number;
  scopePath: string | null;
  sourceFactId: string | null;
  steps: Array<{
    stepIndex: number;
    action: string;
    expectedResult: string | null;
  }>;
}

export async function searchProcedures(
  sql: postgres.Sql,
  options: ProcedureSearchOptions,
): Promise<ProcedureSearchResult[]> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const query = options.query.trim();
  if (!query) return [];

  const run = async (includeLifecycleFilter: boolean) => await sql`
    WITH matches AS (
      SELECT
        p.procedure_id,
        p.title,
        p.summary,
        p.confidence::float AS confidence,
        p.scope_path,
        p.source_fact_id::text AS source_fact_id,
        ts_rank(p.fts, plainto_tsquery('english', ${query})) AS rank
      FROM preserve.procedure p
      WHERE p.tenant = ${tenant}
        AND p.lifecycle_state != 'retired'
        ${lifecycleProcedureVisibleSql(sql, includeLifecycleFilter)}
        AND p.fts @@ plainto_tsquery('english', ${query})
        AND (${options.scope ?? null}::text IS NULL OR COALESCE(p.scope_path, '') LIKE (${options.scope ?? ""} || '%'))
      ORDER BY rank DESC, p.updated_at DESC
      LIMIT ${limit}
    )
    SELECT
      m.procedure_id::text AS procedure_id,
      m.title,
      m.summary,
      m.confidence,
      m.scope_path,
      m.source_fact_id,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'stepIndex', ps.step_index,
            'action', ps.action,
            'expectedResult', ps.expected_result
          )
          ORDER BY ps.step_index
        ) FILTER (WHERE ps.procedure_step_id IS NOT NULL),
        '[]'::jsonb
      ) AS steps
    FROM matches m
    LEFT JOIN preserve.procedure_step ps
      ON ps.procedure_id = m.procedure_id
     AND ps.tenant = ${tenant}
    GROUP BY m.procedure_id, m.title, m.summary, m.confidence, m.scope_path, m.source_fact_id, m.rank
    ORDER BY m.rank DESC, m.title
  `;

  let rows;
  try {
    rows = await run(true);
  } catch (error) {
    if (!isMissingLifecycleIntelligenceTable(error)) throw error;
    rows = await run(false);
  }

  return rows.map((row: any) => ({
    procedureId: row.procedure_id,
    title: row.title,
    summary: row.summary ?? null,
    confidence: Number(row.confidence ?? 0),
    scopePath: row.scope_path ?? null,
    sourceFactId: row.source_fact_id ?? null,
    steps: (row.steps ?? []).map((step: any) => ({
      stepIndex: Number(step.stepIndex),
      action: String(step.action),
      expectedResult: step.expectedResult == null ? null : String(step.expectedResult),
    })),
  }));
}
