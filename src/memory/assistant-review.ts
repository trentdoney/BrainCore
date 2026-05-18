import { createHash } from "crypto";
import { config } from "../config";
import type postgres from "postgres";
import { estimateTokenCount, redactValue, type MemoryTrustClass } from "./governance";

const ASSISTANT_MEMORY_SOURCE_TYPES = ["vestige_memory", "pai_auto_memory"] as const;
const ASSISTANT_REVIEW_REASON = "assistant_memory_import_review";

export interface AssistantReviewRow {
  reviewId: string;
  status: string;
  reason: string;
  sourceType: string;
  sourceKey: string;
  scopePath?: string;
  originalPath?: string;
  factCount: number;
  createdAt?: string;
}

export interface AssistantReviewPromotionResult {
  reviewId: string;
  artifactId: string;
  memoryId: string;
  sourceKey: string;
  supportCount: number;
  trustClass: MemoryTrustClass;
}

export async function listAssistantMemoryReviews(
  sql: postgres.Sql,
  options: { tenant?: string; status?: string; limit?: number } = {},
): Promise<AssistantReviewRow[]> {
  const tenant = options.tenant ?? config.tenant;
  const status = options.status ?? "pending";
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const rows = await sql`
    SELECT
      rq.review_id::text,
      rq.status::text,
      rq.reason,
      a.source_type::text,
      a.source_key,
      a.scope_path,
      a.original_path,
      rq.created_at::text,
      COUNT(f.fact_id)::int AS fact_count
    FROM preserve.review_queue rq
    JOIN preserve.artifact a ON a.artifact_id = rq.target_id
    LEFT JOIN preserve.extraction_run er ON er.artifact_id = a.artifact_id
    LEFT JOIN preserve.fact f ON f.created_run_id = er.run_id AND f.current_status = 'active'
    WHERE rq.target_type = 'artifact'
      AND rq.reason = ${ASSISTANT_REVIEW_REASON}
      AND rq.status = ${status}::preserve.review_status
      AND a.tenant = ${tenant}
      AND a.source_type = ANY(${ASSISTANT_MEMORY_SOURCE_TYPES}::preserve.source_type[])
    GROUP BY rq.review_id, rq.status, rq.reason, a.source_type, a.source_key, a.scope_path, a.original_path, rq.created_at
    ORDER BY rq.created_at ASC
    LIMIT ${limit}
  `;
  return rows.map((row: any) => ({
    reviewId: row.review_id,
    status: row.status,
    reason: row.reason,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    scopePath: row.scope_path ?? undefined,
    originalPath: row.original_path ?? undefined,
    factCount: Number(row.fact_count ?? 0),
    createdAt: row.created_at ?? undefined,
  }));
}

export async function rejectAssistantMemoryReview(
  sql: postgres.Sql,
  reviewId: string,
  options: { tenant?: string; notes?: string; suppressed?: boolean } = {},
): Promise<boolean> {
  const tenant = options.tenant ?? config.tenant;
  const notes = options.suppressed ? `suppressed: ${options.notes ?? "not prompt eligible"}` : options.notes ?? "rejected";
  const rows = await sql`
    UPDATE preserve.review_queue rq
    SET status = 'rejected'::preserve.review_status,
        reviewer_notes = ${notes},
        resolved_at = now()
    FROM preserve.artifact a
    WHERE rq.review_id = ${reviewId}
      AND rq.target_type = 'artifact'
      AND rq.target_id = a.artifact_id
      AND rq.reason = ${ASSISTANT_REVIEW_REASON}
      AND a.tenant = ${tenant}
      AND a.source_type = ANY(${ASSISTANT_MEMORY_SOURCE_TYPES}::preserve.source_type[])
    RETURNING rq.review_id
  `;
  return rows.length > 0;
}

export async function promoteAssistantMemoryReview(
  sql: postgres.Sql,
  reviewId: string,
  options: { tenant?: string; notes?: string; actor?: string } = {},
): Promise<AssistantReviewPromotionResult> {
  const tenant = options.tenant ?? config.tenant;
  return sql.begin(async (tx) => {
    const [target] = await tx`
      SELECT
        rq.review_id::text,
        a.artifact_id::text,
        a.source_type::text,
        a.source_key,
        a.scope_path,
        a.project_entity_id::text,
        a.original_path
      FROM preserve.review_queue rq
      JOIN preserve.artifact a ON a.artifact_id = rq.target_id
      WHERE rq.review_id = ${reviewId}
        AND rq.target_type = 'artifact'
        AND rq.reason = ${ASSISTANT_REVIEW_REASON}
        AND rq.status IN ('pending','approved')
        AND a.tenant = ${tenant}
        AND a.source_type = ANY(${ASSISTANT_MEMORY_SOURCE_TYPES}::preserve.source_type[])
      FOR UPDATE OF rq
      LIMIT 1
    `;
    if (!target) {
      throw new Error("Assistant memory review row not found, not pending, or not in the active tenant.");
    }

    const facts = await tx`
      SELECT
        f.fact_id::text,
        f.episode_id::text,
        f.predicate,
        f.object_value,
        f.confidence::float,
        f.priority,
        f.created_at::text
      FROM preserve.extraction_run er
      JOIN preserve.fact f ON f.created_run_id = er.run_id
      WHERE er.artifact_id = ${target.artifact_id}
        AND f.tenant = ${tenant}
        AND f.current_status = 'active'
      ORDER BY
        CASE WHEN f.predicate IN ('vestige_memory_content','pai_auto_memory_content') THEN 0 ELSE 1 END,
        f.priority ASC,
        f.created_at ASC
      LIMIT 25
    `;
    if (facts.length === 0) {
      throw new Error("Assistant memory review target has no active facts to promote.");
    }

    const narrative = buildAssistantMemoryNarrative(facts as any[]);
    const title = buildAssistantMemoryTitle(target.source_type, target.source_key, narrative);
    const confidence = clampConfidence(Math.max(...facts.map((fact: any) => Number(fact.confidence ?? 0.7))));
    const tokenCount = estimateTokenCount(`${title}\n${narrative}`);
    const fingerprint = sha256(`${tenant}|assistant-import|${target.source_key}`);
    const trustClass: MemoryTrustClass = "human_curated";
    const meta = redactValue({
      assistantImport: true,
      reviewId,
      sourceType: target.source_type,
      sourceKey: target.source_key,
      originalPath: target.original_path,
      reviewedBy: options.actor ?? "braincore-cli",
      reviewedAt: new Date().toISOString(),
    });

    const [memory] = await tx`
      INSERT INTO preserve.memory (
        memory_type, project_entity_id, tenant, fingerprint, title, narrative,
        support_count, contradiction_count, confidence, lifecycle_state,
        pipeline_version, model_name, prompt_version, scope_path, priority,
        last_supported_at, namespace, governance_status, source_class, trust_class,
        salience, strength, stability, quality_score, token_count, governance_meta
      ) VALUES (
        'heuristic'::preserve.memory_type,
        ${target.project_entity_id},
        ${tenant},
        ${fingerprint},
        ${title},
        ${narrative},
        ${facts.length},
        0,
        ${confidence},
        'published'::preserve.lifecycle_state,
        'assistant-memory-review',
        'deterministic-import',
        'assistant-memory-review-v1',
        ${target.scope_path},
        3,
        now(),
        'semantic'::preserve.memory_namespace,
        'validated'::preserve.memory_governance_status,
        'imported_knowledge'::preserve.memory_source_class,
        ${trustClass}::preserve.memory_trust_class,
        0.7,
        0.7,
        0.6,
        ${confidence},
        ${tokenCount},
        ${tx.json(meta as any)}
      )
      ON CONFLICT (tenant, fingerprint) DO UPDATE SET
        title = EXCLUDED.title,
        narrative = EXCLUDED.narrative,
        support_count = EXCLUDED.support_count,
        confidence = EXCLUDED.confidence,
        lifecycle_state = EXCLUDED.lifecycle_state,
        governance_status = EXCLUDED.governance_status,
        trust_class = EXCLUDED.trust_class,
        quality_score = EXCLUDED.quality_score,
        token_count = EXCLUDED.token_count,
        governance_meta = COALESCE(preserve.memory.governance_meta, '{}'::jsonb) || EXCLUDED.governance_meta,
        last_supported_at = now(),
        updated_at = now()
      RETURNING memory_id::text
    `;

    for (const fact of facts as any[]) {
      await tx`
        INSERT INTO preserve.memory_support (memory_id, fact_id, episode_id, support_type, notes)
        VALUES (${memory.memory_id}, ${fact.fact_id}, ${fact.episode_id}, 'supporting', 'assistant memory import review')
        ON CONFLICT DO NOTHING
      `;
    }

    await tx`
      UPDATE preserve.review_queue
      SET status = 'approved'::preserve.review_status,
          reviewer_notes = ${options.notes ?? "approved for BrainCore prompt recall"},
          resolved_at = now()
      WHERE review_id = ${reviewId}
    `;
    await tx`
      UPDATE preserve.artifact
      SET can_promote_memory = true,
          preservation_state = 'published'::preserve.preservation_state,
          updated_at = now()
      WHERE artifact_id = ${target.artifact_id}
        AND tenant = ${tenant}
    `;

    return {
      reviewId,
      artifactId: target.artifact_id,
      memoryId: memory.memory_id,
      sourceKey: target.source_key,
      supportCount: facts.length,
      trustClass,
    };
  });
}

function buildAssistantMemoryTitle(sourceType: string, sourceKey: string, narrative: string): string {
  const firstLine = narrative.split("\n").find((line) => line.trim())?.trim();
  if (firstLine && firstLine.length <= 90) return firstLine;
  const label = sourceType === "vestige_memory" ? "Vestige import" : "PAI auto-memory import";
  return `${label}: ${sourceKey}`.slice(0, 120);
}

function buildAssistantMemoryNarrative(facts: Array<{ predicate: string; object_value: unknown }>): string {
  const contentFacts = facts.filter((fact) => fact.predicate.endsWith("_content"));
  const source = contentFacts[0] ?? facts[0];
  const content = objectValueText(source.object_value).trim();
  const metadata = facts
    .filter((fact) => fact !== source)
    .map((fact) => `${fact.predicate}: ${objectValueText(fact.object_value)}`)
    .filter((line) => line.length > 0)
    .slice(0, 8);
  const lines = [content || "Assistant memory import approved for BrainCore recall."];
  if (metadata.length > 0) {
    lines.push("", "Supporting metadata:", ...metadata.map((line) => `- ${line}`));
  }
  return lines.join("\n");
}

function objectValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(objectValueText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["content", "text", "summary", "title", "value"]) {
      if (key in object) return objectValueText(object[key]);
    }
    return JSON.stringify(redactValue(object));
  }
  return String(value);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.max(0.01, Math.min(0.99, Math.round(value * 100) / 100));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
