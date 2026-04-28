import type postgres from "postgres";
import { config } from "../config";
import { memoryEdgeFingerprint, type MemoryEdgeFingerprintInput } from "./edges";

export type LinkEdgeType = Extract<
  MemoryEdgeFingerprintInput["edgeType"],
  | "supports"
  | "contradicts"
  | "caused_by"
  | "precedes"
  | "follows"
  | "fixes"
  | "mitigates"
  | "supersedes"
  | "duplicates"
  | "depends_on"
>;

export interface LinkCandidate {
  tenant: string;
  sourceType: "fact";
  sourceId: string;
  targetType: "memory";
  targetId: string;
  edgeType: LinkEdgeType;
  edgeFingerprint: string;
  confidence: number;
  assertionClass: "deterministic" | "human_curated" | "corroborated_llm";
  evidenceSegmentId: string | null;
  createdRunId: string | null;
  scopePath: string | null;
  factTitle: string;
  memoryTitle: string;
}

export interface LinkCandidateOptions {
  tenant?: string;
  scope?: string;
  memoryType?: string;
  limit?: number;
}

export interface LinkInsertResult {
  proposed: number;
  inserted: number;
  evidenceRows: number;
}

function clampConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0.5;
  return Math.max(0, Math.min(1, confidence));
}

export async function findLinkCandidates(
  sql: postgres.Sql,
  options: LinkCandidateOptions = {},
): Promise<LinkCandidate[]> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const scope = options.scope;
  const memoryType = options.memoryType;

  const rows = await sql`
    WITH raw_candidates AS (
      SELECT DISTINCT ON (f.fact_id, m.memory_id, ms.support_type)
        f.fact_id::text AS fact_id,
        m.memory_id::text AS memory_id,
        ms.support_type,
        f.fact_kind::text AS fact_kind,
        lower(f.predicate) AS predicate_key,
        lower(COALESCE(f.object_value::text, '')) AS object_key,
        LEAST(
          COALESCE(f.confidence::float, 0.5),
          COALESCE(m.confidence::float, f.confidence::float, 0.5)
        ) AS confidence,
        f.assertion_class::text AS assertion_class,
        f.created_run_id::text AS created_run_id,
        COALESCE(m.scope_path, f.scope_path) AS scope_path,
        f.predicate AS fact_title,
        COALESCE(m.title, m.fingerprint, m.memory_id::text) AS memory_title,
        evidence.segment_id::text AS evidence_segment_id
      FROM preserve.memory_support ms
      JOIN preserve.memory m
        ON m.memory_id = ms.memory_id
       AND m.tenant = ${tenant}
       AND COALESCE(m.lifecycle_state::text, 'draft') != 'retired'
       AND (${memoryType ?? null}::text IS NULL OR m.memory_type::text = ${memoryType ?? ""})
      JOIN preserve.fact f
        ON f.fact_id = ms.fact_id
       AND f.tenant = ${tenant}
       AND f.current_status = 'active'
       AND f.assertion_class IN ('deterministic', 'human_curated', 'corroborated_llm')
       AND f.fact_kind IN ('cause', 'impact', 'decision', 'remediation', 'constraint', 'config_change')
      JOIN LATERAL (
        SELECT fe.segment_id
        FROM preserve.fact_evidence fe
        WHERE fe.fact_id = f.fact_id
        ORDER BY fe.weight DESC NULLS LAST, fe.created_at ASC
        LIMIT 1
      ) evidence ON TRUE
      WHERE ms.fact_id IS NOT NULL
        AND ms.support_type IN ('supporting', 'counter')
        AND (${scope ?? null}::text IS NULL OR COALESCE(m.scope_path, f.scope_path, '') LIKE (${scope ?? ""} || '%'))
      ORDER BY f.fact_id, m.memory_id, ms.support_type, confidence DESC
    ),
    typed_candidates AS (
      SELECT
        *,
        CASE
          WHEN support_type = 'counter' THEN 'contradicts'
          WHEN fact_kind = 'cause' OR predicate_key LIKE '%caus%' THEN 'caused_by'
          WHEN predicate_key LIKE '%preced%' OR predicate_key LIKE '%before%' THEN 'precedes'
          WHEN predicate_key LIKE '%follow%' OR predicate_key LIKE '%after%' THEN 'follows'
          WHEN fact_kind = 'remediation'
            OR predicate_key LIKE '%fix%'
            OR predicate_key LIKE '%remediat%'
            OR object_key LIKE '%fix%'
            OR object_key LIKE '%remediat%' THEN 'fixes'
          WHEN predicate_key LIKE '%mitigat%' OR object_key LIKE '%mitigat%' THEN 'mitigates'
          WHEN predicate_key LIKE '%supersed%' OR object_key LIKE '%supersed%' THEN 'supersedes'
          WHEN predicate_key LIKE '%duplicat%' OR object_key LIKE '%duplicat%' THEN 'duplicates'
          WHEN predicate_key LIKE '%depend%'
            OR predicate_key LIKE '%require%'
            OR object_key LIKE '%depend%'
            OR object_key LIKE '%require%' THEN 'depends_on'
          ELSE 'supports'
        END AS edge_type
      FROM raw_candidates
    ),
    candidates AS (
      SELECT typed_candidates.*
      FROM typed_candidates
      LEFT JOIN preserve.memory_edge existing
        ON existing.tenant = ${tenant}
       AND existing.source_type = 'fact'
       AND existing.source_id = typed_candidates.fact_id::uuid
       AND existing.target_type = 'memory'
       AND existing.target_id = typed_candidates.memory_id::uuid
       AND existing.edge_type = typed_candidates.edge_type
      WHERE existing.edge_id IS NULL
        AND typed_candidates.edge_type != 'supports'
    )
    SELECT *
    FROM candidates
    ORDER BY confidence DESC, fact_id, memory_id, edge_type
    LIMIT ${limit}
  `;

  return rows.map((row: any) => {
    const edgeType = row.edge_type as LinkEdgeType;
    const input: MemoryEdgeFingerprintInput = {
      tenant,
      sourceType: "fact",
      sourceId: row.fact_id,
      edgeType,
      targetType: "memory",
      targetId: row.memory_id,
      scopePath: row.scope_path,
    };
    return {
      tenant,
      sourceType: "fact" as const,
      sourceId: row.fact_id,
      targetType: "memory" as const,
      targetId: row.memory_id,
      edgeType,
      edgeFingerprint: memoryEdgeFingerprint(input),
      confidence: clampConfidence(row.confidence),
      assertionClass: row.assertion_class,
      evidenceSegmentId: row.evidence_segment_id ?? null,
      createdRunId: row.created_run_id ?? null,
      scopePath: row.scope_path ?? null,
      factTitle: row.fact_title,
      memoryTitle: row.memory_title,
    };
  });
}

export async function insertLinkCandidates(
  candidates: LinkCandidate[],
  sql: postgres.Sql,
): Promise<LinkInsertResult> {
  let inserted = 0;
  let evidenceRows = 0;
  await sql.begin(async (tx) => {
    for (const candidate of candidates) {
      const rows = await tx`
        INSERT INTO preserve.memory_edge (
          tenant,
          source_type,
          source_id,
          target_type,
          target_id,
          edge_type,
          edge_fingerprint,
          confidence,
          assertion_class,
          evidence_segment_id,
          created_run_id,
          scope_path
        ) VALUES (
          ${candidate.tenant},
          ${candidate.sourceType},
          ${candidate.sourceId}::uuid,
          ${candidate.targetType},
          ${candidate.targetId}::uuid,
          ${candidate.edgeType},
          ${candidate.edgeFingerprint},
          ${candidate.confidence},
          ${candidate.assertionClass}::preserve.assertion_class,
          ${candidate.evidenceSegmentId}::uuid,
          ${candidate.createdRunId}::uuid,
          ${candidate.scopePath}
        )
        ON CONFLICT (tenant, edge_fingerprint) DO NOTHING
        RETURNING edge_id
      `;
      inserted += rows.length;
      const edgeId = rows[0]?.edge_id;
      if (edgeId && candidate.evidenceSegmentId) {
        const evidence = await tx`
          INSERT INTO preserve.memory_edge_evidence (
            edge_id,
            fact_id,
            segment_id,
            notes
          ) VALUES (
            ${edgeId}::uuid,
            ${candidate.sourceId}::uuid,
            ${candidate.evidenceSegmentId}::uuid,
            ${candidate.edgeType}
          )
          RETURNING edge_evidence_id
        `;
        evidenceRows += evidence.length;
      }
    }
  });
  return { proposed: candidates.length, inserted, evidenceRows };
}
