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
  scopePath?: string;
  supportCount: number;
  trustClass: MemoryTrustClass;
  idempotent: boolean;
}

export interface AssistantReviewDemotionResult {
  memoryId: string;
  reviewId?: string;
  artifactId?: string;
  sourceKey?: string;
  resetReview: boolean;
  demoted: boolean;
}

export interface AssistantReviewDetail extends AssistantReviewRow {
  artifactId: string;
  facts: Array<{ predicate: string; value: string; confidence?: number; factId: string }>;
}

export interface AssistantReviewStats {
  total: number;
  byStatus: Record<string, number>;
  bySourceType: Record<string, number>;
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

export async function getAssistantMemoryReview(
  sql: postgres.Sql,
  reviewId: string,
  options: { tenant?: string; factLimit?: number } = {},
): Promise<AssistantReviewDetail | null> {
  const tenant = options.tenant ?? config.tenant;
  const factLimit = Math.max(1, Math.min(50, options.factLimit ?? 20));
  const [review] = await sql`
    SELECT
      rq.review_id::text,
      rq.status::text,
      rq.reason,
      a.artifact_id::text,
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
    WHERE rq.review_id = ${reviewId}
      AND rq.target_type = 'artifact'
      AND rq.reason = ${ASSISTANT_REVIEW_REASON}
      AND a.tenant = ${tenant}
      AND a.source_type = ANY(${ASSISTANT_MEMORY_SOURCE_TYPES}::preserve.source_type[])
    GROUP BY rq.review_id, rq.status, rq.reason, a.artifact_id, a.source_type, a.source_key, a.scope_path, a.original_path, rq.created_at
    LIMIT 1
  `;
  if (!review) return null;
  const facts = await sql`
    SELECT
      f.fact_id::text,
      f.predicate,
      f.object_value,
      f.confidence::float
    FROM preserve.extraction_run er
    JOIN preserve.fact f ON f.created_run_id = er.run_id
    WHERE er.artifact_id = ${review.artifact_id}
      AND f.tenant = ${tenant}
      AND f.current_status = 'active'
    ORDER BY
      CASE WHEN f.predicate IN ('vestige_memory_content','pai_auto_memory_content') THEN 0 ELSE 1 END,
      f.priority ASC,
      f.created_at ASC
    LIMIT ${factLimit}
  `;
  return {
    reviewId: review.review_id,
    status: review.status,
    reason: review.reason,
    artifactId: review.artifact_id,
    sourceType: review.source_type,
    sourceKey: review.source_key,
    scopePath: review.scope_path ?? undefined,
    originalPath: review.original_path ?? undefined,
    factCount: Number(review.fact_count ?? 0),
    createdAt: review.created_at ?? undefined,
    facts: facts.map((fact: any) => ({
      factId: fact.fact_id,
      predicate: fact.predicate,
      value: objectValueText(fact.object_value),
      confidence: fact.confidence === null || fact.confidence === undefined ? undefined : Number(fact.confidence),
    })),
  };
}

export async function assistantMemoryReviewStats(
  sql: postgres.Sql,
  options: { tenant?: string } = {},
): Promise<AssistantReviewStats> {
  const tenant = options.tenant ?? config.tenant;
  const rows = await sql`
    SELECT rq.status::text, a.source_type::text, COUNT(*)::int AS count
    FROM preserve.review_queue rq
    JOIN preserve.artifact a ON a.artifact_id = rq.target_id
    WHERE rq.target_type = 'artifact'
      AND rq.reason = ${ASSISTANT_REVIEW_REASON}
      AND a.tenant = ${tenant}
      AND a.source_type = ANY(${ASSISTANT_MEMORY_SOURCE_TYPES}::preserve.source_type[])
    GROUP BY rq.status, a.source_type
    ORDER BY rq.status, a.source_type
  `;
  const stats: AssistantReviewStats = { total: 0, byStatus: {}, bySourceType: {} };
  for (const row of rows as any[]) {
    const count = Number(row.count ?? 0);
    stats.total += count;
    stats.byStatus[row.status] = (stats.byStatus[row.status] ?? 0) + count;
    stats.bySourceType[row.source_type] = (stats.bySourceType[row.source_type] ?? 0) + count;
  }
  return stats;
}

export function renderAssistantReviewQueueMarkdown(rows: AssistantReviewRow[]): string {
  const lines = [
    '# BrainCore Assistant Memory Review Queue',
    '',
    `Rows: ${rows.length}`,
    '',
  ];
  for (const row of rows) {
    lines.push(`## ${row.sourceKey}`);
    lines.push(`- Review ID: ${row.reviewId}`);
    lines.push(`- Status: ${row.status}`);
    lines.push(`- Source type: ${row.sourceType}`);
    if (row.scopePath) lines.push(`- Scope: ${row.scopePath}`);
    lines.push(`- Facts: ${row.factCount}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
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

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function promoteAssistantMemoryReview(
  sql: postgres.Sql,
  reviewId: string,
  options: { tenant?: string; notes?: string; actor?: string; scopePath?: string } = {},
): Promise<AssistantReviewPromotionResult> {
  const tenant = options.tenant ?? config.tenant;
  return sql.begin(async (tx) => {
    const [target] = await tx`
      SELECT
        rq.review_id::text,
        rq.status::text AS review_status,
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
      FOR UPDATE OF rq, a
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
    const promotedScopePath = options.scopePath?.trim() || target.scope_path || null;
    const confidence = clampConfidence(Math.max(...facts.map((fact: any) => Number(fact.confidence ?? 0.7))));
    const tokenCount = estimateTokenCount(`${title}\n${narrative}`);
    const fingerprint = sha256(`${tenant}|assistant-import|${target.source_key}`);
    const trustClass: MemoryTrustClass = "human_curated";
    const meta = {
      assistantImport: true,
      reviewId,
      sourceType: target.source_type,
      sourceKey: target.source_key,
      originalPath: redactValue(target.original_path),
      originalScopePath: target.scope_path,
      promotedScopePath,
      reviewedBy: options.actor ?? "braincore-cli",
      reviewedAt: new Date().toISOString(),
    };

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
        ${promotedScopePath},
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
        scope_path = EXCLUDED.scope_path,
        quality_score = EXCLUDED.quality_score,
        token_count = EXCLUDED.token_count,
        governance_meta = COALESCE(preserve.memory.governance_meta, '{}'::jsonb) || EXCLUDED.governance_meta,
        last_supported_at = now(),
        updated_at = now()
      RETURNING memory_id::text
    `;

    await tx`
      DELETE FROM preserve.memory_support
      WHERE memory_id = ${memory.memory_id}
        AND notes = 'assistant memory import review'
    `;
    for (const fact of facts as any[]) {
      await tx`
        INSERT INTO preserve.memory_support (memory_id, fact_id, episode_id, support_type, notes)
        VALUES (${memory.memory_id}, ${fact.fact_id}, ${fact.episode_id}, 'supporting', 'assistant memory import review')
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
      scopePath: promotedScopePath ?? undefined,
      supportCount: facts.length,
      trustClass,
      idempotent: target.review_status === "approved",
    };
  });
}

export async function demoteAssistantMemoryPromotion(
  sql: postgres.Sql,
  memoryId: string,
  options: { tenant?: string; notes?: string; actor?: string } = {},
): Promise<AssistantReviewDemotionResult> {
  const tenant = options.tenant ?? config.tenant;
  return sql.begin(async (tx) => {
    const [memory] = await tx`
      SELECT
        memory_id::text,
        fingerprint,
        governance_meta,
        governance_status::text,
        source_class::text,
        trust_class::text
      FROM preserve.memory
      WHERE memory_id = ${memoryId}
        AND tenant = ${tenant}
        AND source_class = 'imported_knowledge'::preserve.memory_source_class
        AND trust_class = 'human_curated'::preserve.memory_trust_class
      FOR UPDATE
      LIMIT 1
    `;
    if (!memory) {
      throw new Error("Assistant memory promotion not found for the active tenant.");
    }

    const meta = (memory.governance_meta ?? {}) as Record<string, unknown>;
    let reviewId = isUuid(meta.reviewId) ? meta.reviewId : undefined;
    let sourceKey = typeof meta.sourceKey === "string" && !meta.sourceKey.includes("[REDACTED") ? meta.sourceKey : undefined;

    if (!reviewId) {
      const [linkedReview] = await tx`
        SELECT rq.review_id::text, a.source_key
        FROM preserve.memory_support ms
        JOIN preserve.fact f ON f.fact_id = ms.fact_id
        JOIN preserve.extraction_run er ON er.run_id = f.created_run_id
        JOIN preserve.artifact a ON a.artifact_id = er.artifact_id
        JOIN preserve.review_queue rq ON rq.target_id = a.artifact_id
        WHERE ms.memory_id = ${memoryId}
          AND ms.notes = 'assistant memory import review'
          AND rq.target_type = 'artifact'
          AND rq.reason = ${ASSISTANT_REVIEW_REASON}
          AND a.tenant = ${tenant}
        LIMIT 1
      `;
      if (linkedReview) {
        reviewId = linkedReview.review_id;
        sourceKey = linkedReview.source_key;
      }
    }

    await tx`
      DELETE FROM preserve.memory_support
      WHERE memory_id = ${memoryId}
        AND notes = 'assistant memory import review'
    `;

    await tx`
      UPDATE preserve.memory
      SET governance_status = 'suppressed'::preserve.memory_governance_status,
          lifecycle_state = 'retired'::preserve.lifecycle_state,
          governance_meta = COALESCE(governance_meta, '{}'::jsonb) || ${tx.json(redactValue({
            assistantImportDemoted: true,
            demotedAt: new Date().toISOString(),
            demotedBy: options.actor ?? "braincore-cli",
            demotionReason: options.notes ?? "assistant memory promotion rollback",
          }) as any)}::jsonb,
          updated_at = now()
      WHERE memory_id = ${memoryId}
        AND tenant = ${tenant}
    `;

    let artifactId: string | undefined;
    let resetReview = false;
    if (reviewId) {
      const [review] = await tx`
        UPDATE preserve.review_queue rq
        SET status = 'pending'::preserve.review_status,
            reviewer_notes = ${options.notes ?? "promotion demoted for re-review"},
            resolved_at = NULL
        FROM preserve.artifact a
        WHERE rq.review_id = ${reviewId}
          AND rq.target_type = 'artifact'
          AND rq.target_id = a.artifact_id
          AND rq.reason = ${ASSISTANT_REVIEW_REASON}
          AND a.tenant = ${tenant}
        RETURNING a.artifact_id::text
      `;
      if (review) {
        const reviewedArtifactId = review.artifact_id as string;
        artifactId = reviewedArtifactId;
        resetReview = true;
        await tx`
          UPDATE preserve.artifact
          SET can_promote_memory = false,
              preservation_state = 'archived'::preserve.preservation_state,
              updated_at = now()
          WHERE artifact_id = ${reviewedArtifactId}
            AND tenant = ${tenant}
        `;
      }
    }

    return { memoryId, reviewId, artifactId, sourceKey, resetReview, demoted: true };
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
