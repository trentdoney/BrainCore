/**
 * patterns.ts — Find pattern candidates from high-trust facts.
 * Only facts with deterministic, human_curated, or corroborated_llm
 * assertion classes qualify. Candidates need 2+ independent support
 * units (distinct episodes).
 */

import type postgres from "postgres";
import { createHash } from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PatternCandidate {
  /** Subject pattern (e.g., "server-a", "docker") */
  subject: string;
  /** Predicate grouping key */
  predicate: string;
  /** fact_kind for this group */
  factKind: string;
  /** Number of independent episodes supporting this pattern */
  supportCount: number;
  /** IDs of supporting facts */
  factIds: string[];
  /** IDs of independent episodes */
  episodeIds: string[];
  /** Representative object_value from the most common fact */
  representativeValue: string;
  /** Fingerprint for deduplication: sha256(subject|predicate|fact_kind) */
  fingerprint: string;
  /** Scope path from most specific supporting fact */
  scopePath: string | null;
}

function patternFingerprint(subject: string, predicate: string, factKind: string): string {
  const raw = `pattern:${subject}|${predicate}|${factKind}`;
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}

// ── Main Query ───────────────────────────────────────────────────────────────

/**
 * Find pattern candidates from high-trust facts grouped by
 * (subject_entity canonical_name, predicate, fact_kind).
 * Only groups with 2+ independent episode support qualify.
 */
export async function findPatternCandidates(
  sql: postgres.Sql,
): Promise<PatternCandidate[]> {
  // Query: group high-trust active facts by entity+predicate+kind,
  // require 2+ distinct episodes
  const rows = await sql`
    WITH trusted_facts AS (
      SELECT
        f.fact_id,
        e.canonical_name AS subject,
        f.predicate,
        f.fact_kind::text AS fact_kind,
        f.object_value::text AS object_value,
        f.episode_id,
        f.scope_path
      FROM preserve.fact f
      JOIN preserve.entity e ON f.subject_entity_id = e.entity_id
      LEFT JOIN preserve.entity e_proj ON f.project_entity_id = e_proj.entity_id
      WHERE f.assertion_class IN ('deterministic', 'human_curated', 'corroborated_llm')
        AND f.current_status = 'active'
        AND (e_proj.entity_id IS NULL OR COALESCE(e_proj.attrs->>'status', 'active') != 'archived')
    ),
    grouped AS (
      SELECT
        subject,
        predicate,
        fact_kind,
        COUNT(DISTINCT episode_id) AS episode_count,
        array_agg(DISTINCT fact_id::text) AS fact_ids,
        array_agg(DISTINCT episode_id::text) FILTER (WHERE episode_id IS NOT NULL) AS episode_ids,
        mode() WITHIN GROUP (ORDER BY object_value) AS representative_value,
        (array_agg(scope_path ORDER BY scope_path NULLS LAST))[1] AS scope_path
      FROM trusted_facts
      GROUP BY subject, predicate, fact_kind
      HAVING COUNT(DISTINCT episode_id) >= 2
    )
    SELECT * FROM grouped
    ORDER BY episode_count DESC, subject, predicate
  `;

  return rows.map((r: any) => ({
    subject: r.subject,
    predicate: r.predicate,
    factKind: r.fact_kind,
    supportCount: Number(r.episode_count),
    factIds: r.fact_ids || [],
    episodeIds: (r.episode_ids || []).filter(Boolean),
    representativeValue: r.representative_value || "",
    fingerprint: patternFingerprint(r.subject, r.predicate, r.fact_kind),
    scopePath: r.scope_path || null,
  }));
}
