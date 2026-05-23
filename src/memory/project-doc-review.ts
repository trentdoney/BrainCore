import { readFile } from "fs/promises";
import { createHash } from "crypto";
import type postgres from "postgres";
import { config } from "../config";
import { estimateTokenCount, redactValue } from "./governance";

export const PROJECT_DOC_REVIEW_REASON = "project_doc_value_review";

export interface ProjectDocReviewRow {
  reviewId: string;
  status: string;
  sourceKey: string;
  scopePath?: string;
  originalPath?: string;
  factCount: number;
  createdAt?: string;
}

export interface ProjectDocReviewDecisionFile {
  decisions: ProjectDocReviewDecision[];
}

export interface ProjectDocReviewDecision {
  reviewId: string;
  decision: "approved" | "rejected";
  title?: string;
  content?: string;
  materiality?: string;
  retrievalUseCase?: string;
  notes?: string;
  scopePath?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.85;
  return Math.max(0.01, Math.min(0.99, Math.round(value * 100) / 100));
}

function requireUsefulText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text || text.length < 16) throw new Error(`Approved project-doc decisions require ${label}.`);
  return text;
}

function decisionNotes(decision: ProjectDocReviewDecision): string {
  return [
    decision.notes?.trim(),
    decision.materiality ? `materiality: ${decision.materiality.trim()}` : undefined,
    decision.retrievalUseCase ? `retrieval_use_case: ${decision.retrievalUseCase.trim()}` : undefined,
  ].filter(Boolean).join("\n") || decision.decision;
}

export async function listProjectDocReviews(
  sql: postgres.Sql,
  options: { tenant?: string; status?: string; limit?: number } = {},
): Promise<ProjectDocReviewRow[]> {
  const tenant = options.tenant ?? config.tenant;
  const status = options.status ?? "pending";
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const rows = await sql`
    SELECT
      rq.review_id::text,
      rq.status::text,
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
      AND rq.reason = ${PROJECT_DOC_REVIEW_REASON}
      AND rq.status = ${status}::preserve.review_status
      AND a.tenant = ${tenant}
      AND a.source_type = 'project_doc'::preserve.source_type
    GROUP BY rq.review_id, rq.status, a.source_key, a.scope_path, a.original_path, rq.created_at
    ORDER BY rq.created_at ASC
    LIMIT ${limit}
  `;
  return rows.map((row: any) => ({
    reviewId: row.review_id,
    status: row.status,
    sourceKey: row.source_key,
    scopePath: row.scope_path ?? undefined,
    originalPath: row.original_path ?? undefined,
    factCount: Number(row.fact_count ?? 0),
    createdAt: row.created_at ?? undefined,
  }));
}

export function renderProjectDocReviewPacket(rows: ProjectDocReviewRow[]): string {
  const lines = ["# BrainCore Project Doc Value Review", "", `Rows: ${rows.length}`, ""];
  for (const row of rows) {
    lines.push(`## ${row.sourceKey}`);
    lines.push(`- Review ID: ${row.reviewId}`);
    lines.push(`- Status: ${row.status}`);
    if (row.scopePath) lines.push(`- Scope: ${row.scopePath}`);
    if (row.originalPath) lines.push(`- Source: ${row.originalPath}`);
    lines.push(`- Facts: ${row.factCount}`);
    lines.push("- Decision: pending");
    lines.push("- Value gate: must improve project decisions, be current, non-duplicative, and evidence-backed.");
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export async function queueProjectDocReview(sql: postgres.Sql, artifactId: string, tenant = config.tenant): Promise<void> {
  await sql`
    INSERT INTO preserve.review_queue (target_type, target_id, reason, status)
    SELECT 'artifact', ${artifactId}::uuid, ${PROJECT_DOC_REVIEW_REASON}, 'pending'::preserve.review_status
    WHERE EXISTS (
      SELECT 1 FROM preserve.artifact a
      WHERE a.artifact_id = ${artifactId}::uuid
        AND a.tenant = ${tenant}
        AND a.source_type = 'project_doc'::preserve.source_type
    )
    AND NOT EXISTS (
      SELECT 1 FROM preserve.review_queue rq
      WHERE rq.target_type = 'artifact'
        AND rq.target_id = ${artifactId}::uuid
        AND rq.reason = ${PROJECT_DOC_REVIEW_REASON}
    )
  `;
}

export async function applyProjectDocReviewDecisions(
  sql: postgres.Sql,
  decisionPath: string,
  options: { tenant?: string; actor?: string } = {},
): Promise<{ approved: number; rejected: number; memories: string[] }> {
  const tenant = options.tenant ?? config.tenant;
  const parsed = JSON.parse(await readFile(decisionPath, "utf-8")) as ProjectDocReviewDecisionFile;
  if (!Array.isArray(parsed.decisions)) throw new Error("Project doc decisions file requires decisions array.");
  const memories: string[] = [];
  let approved = 0;
  let rejected = 0;

  await sql.begin(async (tx) => {
    for (const decision of parsed.decisions) {
      if (!decision.reviewId) throw new Error("Every project-doc decision requires reviewId.");
      const [target] = await tx`
        SELECT
          rq.review_id::text,
          rq.status::text AS review_status,
          a.artifact_id::text,
          a.source_key,
          a.scope_path,
          a.project_entity_id::text,
          a.original_path
        FROM preserve.review_queue rq
        JOIN preserve.artifact a ON a.artifact_id = rq.target_id
        WHERE rq.review_id = ${decision.reviewId}
          AND rq.target_type = 'artifact'
          AND rq.reason = ${PROJECT_DOC_REVIEW_REASON}
          AND rq.status IN ('pending'::preserve.review_status,'approved'::preserve.review_status)
          AND a.tenant = ${tenant}
          AND a.source_type = 'project_doc'::preserve.source_type
        FOR UPDATE OF rq, a
        LIMIT 1
      `;
      if (!target) throw new Error(`Project doc review row not found or not actionable: ${decision.reviewId}`);

      if (decision.decision === "rejected") {
        const [publishedMemory] = await tx`
          SELECT m.memory_id::text
          FROM preserve.memory m
          JOIN preserve.memory_support ms ON ms.memory_id = m.memory_id
          JOIN preserve.fact f ON f.fact_id = ms.fact_id
          JOIN preserve.extraction_run er ON er.run_id = f.created_run_id
          WHERE er.artifact_id = ${target.artifact_id}
            AND m.tenant = ${tenant}
            AND ms.notes = 'project doc value review'
            AND m.lifecycle_state != 'retired'::preserve.lifecycle_state
          FOR UPDATE OF m
          LIMIT 1
        `;
        if (publishedMemory) {
          await tx`
            DELETE FROM preserve.memory_support
            WHERE memory_id = ${publishedMemory.memory_id}
              AND notes = 'project doc value review'
          `;
          await tx`
            UPDATE preserve.memory
            SET governance_status = 'suppressed'::preserve.memory_governance_status,
                lifecycle_state = 'retired'::preserve.lifecycle_state,
                governance_meta = COALESCE(governance_meta, '{}'::jsonb) || ${tx.json(redactValue({
                  projectDocReviewRejected: true,
                  reviewId: decision.reviewId,
                  rejectedAt: new Date().toISOString(),
                  rejectedBy: options.actor ?? "braincore-cli",
                  rejectionReason: decisionNotes(decision),
                }) as any)}::jsonb,
                updated_at = now()
            WHERE memory_id = ${publishedMemory.memory_id}
              AND tenant = ${tenant}
          `;
        }
        await tx`
          UPDATE preserve.review_queue
          SET status = 'rejected'::preserve.review_status,
              reviewer_notes = ${decisionNotes(decision)},
              resolved_at = now()
          WHERE review_id = ${decision.reviewId}
        `;
        await tx`
          UPDATE preserve.artifact
          SET can_promote_memory = false,
              preservation_state = 'archived'::preserve.preservation_state,
              updated_at = now()
          WHERE artifact_id = ${target.artifact_id}
            AND tenant = ${tenant}
        `;
        rejected++;
        continue;
      }

      if (decision.decision !== "approved") throw new Error(`Unsupported decision for ${decision.reviewId}: ${decision.decision}`);
      const title = requireUsefulText(decision.title, "title");
      const content = requireUsefulText(decision.content, "content");
      const materiality = requireUsefulText(decision.materiality, "materiality");
      const retrievalUseCase = requireUsefulText(decision.retrievalUseCase, "retrievalUseCase");

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
        ORDER BY f.priority ASC, f.created_at ASC
        LIMIT 50
      `;
      if (facts.length === 0) throw new Error(`Approved project doc review has no active facts: ${decision.reviewId}`);

      const scopePath = decision.scopePath?.trim() || target.scope_path || null;
      const confidence = clampConfidence(Math.max(...facts.map((fact: any) => Number(fact.confidence ?? 0.85))));
      const narrative = `${content.trim()}\n\nMateriality: ${materiality}\n\nRetrieval use case: ${retrievalUseCase}`;
      const tokenCount = estimateTokenCount(`${title}\n${narrative}`);
      const fingerprint = sha256(`${tenant}|project-doc-review|${decision.reviewId}`);
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
          'project-doc-review',
          'deterministic-project-doc',
          'project-doc-review-v1',
          ${scopePath},
          3,
          now(),
          'semantic'::preserve.memory_namespace,
          'validated'::preserve.memory_governance_status,
          'imported_knowledge'::preserve.memory_source_class,
          'human_curated'::preserve.memory_trust_class,
          0.75,
          0.75,
          0.7,
          ${confidence},
          ${tokenCount},
          ${tx.json(redactValue({
            projectDocReview: true,
            reviewId: decision.reviewId,
            sourceKey: target.source_key,
            originalPath: target.original_path,
            materiality,
            retrievalUseCase,
            reviewedBy: options.actor ?? "braincore-cli",
            reviewedAt: new Date().toISOString(),
          }) as any)}
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
          AND notes = 'project doc value review'
      `;
      for (const fact of facts as any[]) {
        await tx`
          INSERT INTO preserve.memory_support (memory_id, fact_id, episode_id, support_type, notes)
          VALUES (${memory.memory_id}, ${fact.fact_id}, ${fact.episode_id}, 'supporting', 'project doc value review')
        `;
      }
      await tx`
        UPDATE preserve.review_queue
        SET status = 'approved'::preserve.review_status,
            reviewer_notes = ${decisionNotes(decision)},
            resolved_at = now()
        WHERE review_id = ${decision.reviewId}
      `;
      await tx`
        UPDATE preserve.artifact
        SET can_promote_memory = true,
            preservation_state = 'published'::preserve.preservation_state,
            updated_at = now()
        WHERE artifact_id = ${target.artifact_id}
          AND tenant = ${tenant}
      `;
      approved++;
      memories.push(memory.memory_id);
    }
  });

  return { approved, rejected, memories };
}
