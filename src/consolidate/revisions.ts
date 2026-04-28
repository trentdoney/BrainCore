import type postgres from "postgres";
import { config } from "../config";

export type MemoryRevisionType = "created" | "enriched" | "merged" | "demoted" | "retired";
export type DerivedMemoryClass = "experience" | "entity_summary" | "belief" | "rule";

export interface MemoryRevisionCandidate {
  tenant: string;
  memoryId: string;
  revisionType: MemoryRevisionType;
  derivedClass: DerivedMemoryClass;
  title: string;
  oldNarrative: string | null;
  newNarrative: string | null;
  changeReason: string;
  supportFactId: string | null;
  supportEpisodeId: string | null;
}

export interface RevisionOptions {
  tenant?: string;
  scope?: string | null;
  limit?: number;
}

export interface InsertRevisionResult {
  proposed: number;
  inserted: number;
  supportRows: number;
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 100, 1000));
}

export async function findMemoryRevisionCandidates(
  sql: postgres.Sql,
  options: RevisionOptions = {},
): Promise<MemoryRevisionCandidate[]> {
  const tenant = options.tenant ?? config.tenant;
  const scope = options.scope ?? null;
  const limit = clampLimit(options.limit);

  const rows = await sql`
    WITH memory_scope AS (
      SELECT m.*
      FROM preserve.memory m
      WHERE m.tenant = ${tenant}
        AND (${scope}::text IS NULL OR COALESCE(m.scope_path, '') LIKE (${scope ?? ""} || '%'))
    ),
    support AS (
      SELECT DISTINCT ON (ms.memory_id)
        ms.memory_id,
        ms.fact_id::text AS fact_id,
        ms.episode_id::text AS episode_id
      FROM preserve.memory_support ms
      JOIN memory_scope m ON m.memory_id = ms.memory_id
      ORDER BY ms.memory_id, ms.created_at ASC
    ),
    duplicate_titles AS (
      SELECT
        memory_id,
        first_value(memory_id) OVER (
          PARTITION BY lower(COALESCE(title, '')), COALESCE(scope_path, '')
          ORDER BY support_count DESC NULLS LAST, confidence DESC NULLS LAST, updated_at DESC
        ) AS canonical_memory_id,
        row_number() OVER (
          PARTITION BY lower(COALESCE(title, '')), COALESCE(scope_path, '')
          ORDER BY support_count DESC NULLS LAST, confidence DESC NULLS LAST, updated_at DESC
        ) AS duplicate_rank,
        count(*) OVER (
          PARTITION BY lower(COALESCE(title, '')), COALESCE(scope_path, '')
        ) AS duplicate_count
      FROM memory_scope
      WHERE title IS NOT NULL
    ),
    proposals AS (
      SELECT
        m.memory_id::text AS memory_id,
        'created'::text AS revision_type,
        CASE
          WHEN m.memory_type = 'entity_summary' THEN 'entity_summary'
          WHEN m.valid_from IS NOT NULL OR s.episode_id IS NOT NULL THEN 'experience'
          WHEN m.memory_type = 'playbook' THEN 'rule'
          WHEN m.memory_type IN ('pattern', 'heuristic') THEN 'belief'
          ELSE 'belief'
        END AS derived_class,
        m.title,
        m.narrative AS old_narrative,
        m.narrative AS new_narrative,
        'Promote high-support draft memory through review before durable publication.' AS change_reason,
        s.fact_id,
        s.episode_id,
        10 AS priority
      FROM memory_scope m
      LEFT JOIN support s ON s.memory_id = m.memory_id
      WHERE m.lifecycle_state = 'draft'
        AND COALESCE(m.support_count, 0) >= 2

      UNION ALL

      SELECT
        m.memory_id::text,
        'enriched'::text,
        CASE
          WHEN m.memory_type = 'entity_summary' THEN 'entity_summary'
          WHEN m.valid_from IS NOT NULL OR s.episode_id IS NOT NULL THEN 'experience'
          WHEN m.memory_type = 'playbook' THEN 'rule'
          WHEN m.memory_type IN ('pattern', 'heuristic') THEN 'belief'
          ELSE 'belief'
        END,
        m.title,
        m.narrative,
        COALESCE(m.narrative, '') || E'\n\nEvidence refresh: support=' || COALESCE(m.support_count, 0)::text
          || ', contradictions=' || COALESCE(m.contradiction_count, 0)::text || '.',
        'Refresh narrative with current support and contradiction counts.',
        s.fact_id,
        s.episode_id,
        20 AS priority
      FROM memory_scope m
      LEFT JOIN support s ON s.memory_id = m.memory_id
      WHERE m.lifecycle_state != 'retired'
        AND COALESCE(m.support_count, 0) >= 2
        AND length(COALESCE(m.narrative, '')) < 220

      UNION ALL

      SELECT
        m.memory_id::text,
        'merged'::text,
        CASE
          WHEN m.memory_type = 'entity_summary' THEN 'entity_summary'
          WHEN m.valid_from IS NOT NULL OR s.episode_id IS NOT NULL THEN 'experience'
          WHEN m.memory_type = 'playbook' THEN 'rule'
          WHEN m.memory_type IN ('pattern', 'heuristic') THEN 'belief'
          ELSE 'belief'
        END,
        m.title,
        m.narrative,
        m.narrative,
        'Duplicate title/scope candidate; review merge into memory '
          || dt.canonical_memory_id::text || '.',
        s.fact_id,
        s.episode_id,
        30 AS priority
      FROM memory_scope m
      JOIN duplicate_titles dt ON dt.memory_id = m.memory_id
      LEFT JOIN support s ON s.memory_id = m.memory_id
      WHERE dt.duplicate_count > 1
        AND dt.duplicate_rank > 1
        AND m.lifecycle_state != 'retired'

      UNION ALL

      SELECT
        m.memory_id::text,
        'demoted'::text,
        CASE
          WHEN m.memory_type = 'entity_summary' THEN 'entity_summary'
          WHEN m.valid_from IS NOT NULL OR s.episode_id IS NOT NULL THEN 'experience'
          WHEN m.memory_type = 'playbook' THEN 'rule'
          WHEN m.memory_type IN ('pattern', 'heuristic') THEN 'belief'
          ELSE 'belief'
        END,
        m.title,
        m.narrative,
        m.narrative,
        'Published memory has stale or missing support; demote to draft for review.',
        s.fact_id,
        s.episode_id,
        40 AS priority
      FROM memory_scope m
      LEFT JOIN support s ON s.memory_id = m.memory_id
      WHERE m.lifecycle_state = 'published'
        AND (
          m.last_supported_at IS NULL
          OR m.last_supported_at < now() - interval '6 months'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM preserve.memory_support ms
          JOIN preserve.fact f ON f.fact_id = ms.fact_id
          WHERE ms.memory_id = m.memory_id
            AND f.tenant = ${tenant}
            AND f.priority = 1
        )

      UNION ALL

      SELECT
        m.memory_id::text,
        'retired'::text,
        CASE
          WHEN m.memory_type = 'entity_summary' THEN 'entity_summary'
          WHEN m.valid_from IS NOT NULL OR s.episode_id IS NOT NULL THEN 'experience'
          WHEN m.memory_type = 'playbook' THEN 'rule'
          WHEN m.memory_type IN ('pattern', 'heuristic') THEN 'belief'
          ELSE 'belief'
        END,
        m.title,
        m.narrative,
        m.narrative,
        'Contradictions exceed support; retire after review.',
        s.fact_id,
        s.episode_id,
        50 AS priority
      FROM memory_scope m
      LEFT JOIN support s ON s.memory_id = m.memory_id
      WHERE m.lifecycle_state != 'retired'
        AND COALESCE(m.contradiction_count, 0) > COALESCE(m.support_count, 0)
        AND m.created_at < now() - interval '7 days'
    )
    SELECT *
    FROM proposals
    ORDER BY priority, title, memory_id
    LIMIT ${limit}
  `;

  return rows.map((row: any) => ({
    tenant,
    memoryId: String(row.memory_id),
    revisionType: row.revision_type as MemoryRevisionType,
    derivedClass: row.derived_class as DerivedMemoryClass,
    title: String(row.title ?? "(untitled memory)"),
    oldNarrative: row.old_narrative ?? null,
    newNarrative: row.new_narrative ?? null,
    changeReason: String(row.change_reason),
    supportFactId: row.fact_id ?? null,
    supportEpisodeId: row.episode_id ?? null,
  }));
}

export async function insertMemoryRevisionCandidates(
  candidates: MemoryRevisionCandidate[],
  sql: postgres.Sql,
): Promise<InsertRevisionResult> {
  let inserted = 0;
  let supportRows = 0;

  await sql.begin(async (tx) => {
    for (const candidate of candidates) {
      const rows = await tx`
        INSERT INTO preserve.memory_revision (
          memory_id,
          tenant,
          revision_type,
          old_narrative,
          new_narrative,
          change_reason,
          model_name,
          prompt_version
        )
        SELECT
          ${candidate.memoryId}::uuid,
          ${candidate.tenant},
          ${candidate.revisionType},
          ${candidate.oldNarrative},
          ${candidate.newNarrative},
          ${candidate.changeReason},
          'deterministic-revision-planner',
          'revise-memories-v1'

        WHERE NOT EXISTS (
          SELECT 1
          FROM preserve.memory_revision mr
          WHERE mr.memory_id = ${candidate.memoryId}::uuid
            AND mr.tenant = ${candidate.tenant}
            AND mr.revision_type = ${candidate.revisionType}
            AND mr.change_reason = ${candidate.changeReason}
            AND mr.prompt_version = 'revise-memories-v1'
        )
        RETURNING revision_id
      `;
      if (rows.length === 0) continue;
      inserted++;
      const revisionId = rows[0].revision_id;
      if (candidate.supportFactId || candidate.supportEpisodeId) {
        const support = await tx`
          INSERT INTO preserve.memory_revision_support (
            revision_id,
            fact_id,
            episode_id,
            notes
          )
          VALUES (
            ${revisionId}::uuid,
            ${candidate.supportFactId}::uuid,
            ${candidate.supportEpisodeId}::uuid,
            ${candidate.revisionType}
          )
          RETURNING revision_support_id
        `;
        supportRows += support.length;
      }
    }
  });

  return { proposed: candidates.length, inserted, supportRows };
}
