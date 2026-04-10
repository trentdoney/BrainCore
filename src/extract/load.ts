/**
 * load.ts — Load verified extractions into PostgreSQL preserve schema.
 * All writes in a single transaction. Upserts entities, inserts segments,
 * episodes, facts, and fact_evidence. Updates artifact query/promote flags.
 *
 * Aligned to actual preserve schema: entity uses canonical_name, fact uses
 * subject_entity_id/object_entity_id FKs, fact_evidence requires excerpt +
 * source_sha256 + excerpt_hash, etc.
 *
 * Uses sql.json() for all jsonb column values to avoid double-encoding.
 */

import type postgres from "postgres";
import { createHash } from "crypto";
import type { DeterministicResult, Segment, Fact } from "./deterministic";
import type { SemanticResult, SemanticFact } from "./semantic";
import { config } from "../config";
import { checkQualityGate, type FactCandidate } from "./quality-gate";

export interface LoadResult {
  entitiesCreated: number;
  factsCreated: number;
  segmentsCreated: number;
  episodeId: string | null;
  warnings: string[];
  qualityGate?: {
    duplicateCount: number;
    rejectedCount: number;
    acceptedCount: number;
    updatedCount: number;
    reasons: string[];
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Build a canonical fingerprint for a fact to enable deduplication.
 * Format: sha256(subject_name|predicate|object_value_json)
 */
function factFingerprint(
  subjectName: string,
  predicate: string,
  objectValue: any,
): string {
  const raw = `${subjectName}|${predicate}|${JSON.stringify(objectValue ?? "")}`;
  return sha256(raw);
}

/**
 * Compute a fact's priority (1 = highest, 10 = lowest, default 5) based on
 * the signals available at insert time. Matches the retroactive classification
 * used by scripts/backfill-priority.py so newly ingested facts rank the same
 * as existing ones.
 *
 * Priority ladder:
 *   1  milestone facts
 *   2  facts from critical / P1 episodes
 *   3  corroborated_llm facts
 *   4  deterministic facts
 *   5  default (single_source_llm, lessons, everything else)
 */
function computePriority(fact: {
  is_milestone?: boolean;
  assertion_class?: string;
  severity?: string;
}): number {
  if (fact.is_milestone) return 1;
  if (fact.severity === "critical" || fact.severity === "P1") return 2;
  if (fact.assertion_class === "corroborated_llm") return 3;
  if (fact.assertion_class === "deterministic") return 4;
  return 5;
}

/**
 * Attempt to generate an embedding for text via the local embed service.
 * Returns null if the service is unavailable.
 */
async function tryEmbed(text: string): Promise<number[] | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(config.embed.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = (await res.json()) as { embedding?: number[] };
    return data.embedding || null;
  } catch {
    return null;
  }
}


/**
 * Safely parse a date string into a Date object.
 * Handles: ISO 8601, YYYY-MM-DD, various formats.
 * Returns null for invalid/unparseable dates (null, "n/a", "N/A", "TBD", etc.)
 */
function safeParseDate(value: string | null | undefined): Date | null {
  if (!value) return null;

  const trimmed = String(value).trim().toLowerCase();

  // Reject known non-date values
  const invalidValues = ["null", "n/a", "na", "tbd", "none", "unknown", "-", ""];
  if (invalidValues.includes(trimmed)) return null;

  // Try parsing with Date constructor (handles ISO 8601, YYYY-MM-DD, etc.)
  const d = new Date(value);
  if (!isNaN(d.getTime())) {
    // Sanity: reject dates before 2020 or after 2030 (likely garbage)
    const year = d.getFullYear();
    if (year < 2020 || year > 2030) return null;
    return d;
  }

  // Try common alternative formats: DD/MM/YYYY, MM/DD/YYYY
  const slashMatch = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, a, b, y] = slashMatch;
    // Try MM/DD/YYYY first (US format)
    const usDate = new Date(`${y}-${a.padStart(2, "0")}-${b.padStart(2, "0")}`);
    if (!isNaN(usDate.getTime())) return usDate;
  }

  return null;
}

/**
 * Validate and fix a date range. If start > end, swap them.
 * Returns [start, end] with both potentially null.
 */
function validateDateRange(
  startVal: string | null | undefined,
  endVal: string | null | undefined,
): [Date | null, Date | null] {
  let start = safeParseDate(startVal);
  let end = safeParseDate(endVal);

  // If both exist and start > end, swap them
  if (start && end && start.getTime() > end.getTime()) {
    [start, end] = [end, start];
  }

  return [start, end];
}

/**
 * Resolve or create an entity by canonical_name + entity_type.
 * Returns the entity_id UUID.
 */
async function resolveEntity(
  tx: postgres.TransactionSql,
  name: string,
  entityType: string,
): Promise<string> {
  const [row] = await tx`
    INSERT INTO preserve.entity (canonical_name, entity_type, first_seen_at, last_seen_at, tenant)
    VALUES (${name}, ${entityType}::preserve.entity_type, now(), now(), ${config.tenant})
    ON CONFLICT (entity_type, canonical_name) DO UPDATE SET
      last_seen_at = now()
    RETURNING entity_id
  `;
  return row.entity_id;
}

/**
 * Load all deterministic + semantic extractions into the preserve schema.
 * The `db` parameter is the postgres.js Sql instance (for db.json() access).
 */
export async function loadExtraction(
  artifactId: string,
  deterministic: DeterministicResult,
  semantic: SemanticResult | null,
  db: postgres.Sql,
  sourceContent: string,
): Promise<LoadResult> {
  const warnings: string[] = [];
  let entitiesCreated = 0;
  let factsCreated = 0;
  let segmentsCreated = 0;
  let episodeId: string | null = null;
  let qualityGateResult: Awaited<ReturnType<typeof checkQualityGate>> | null = null;

  const contentHash = sha256(sourceContent);

  await db.begin(async (tx) => {

    // ── 0. Clean previous extraction data for re-runs ──────────────────────
    // Delete in dependency order: memory_support -> fact_evidence -> fact -> segment -> episode -> extraction_run
    await tx`DELETE FROM preserve.memory_support WHERE fact_id IN (
      SELECT f.fact_id FROM preserve.fact f
      JOIN preserve.extraction_run r ON f.created_run_id = r.run_id
      WHERE r.artifact_id = ${artifactId}::uuid
    )`.catch(() => {});
    await tx`DELETE FROM preserve.fact_evidence WHERE fact_id IN (
      SELECT f.fact_id FROM preserve.fact f
      JOIN preserve.extraction_run r ON f.created_run_id = r.run_id
      WHERE r.artifact_id = ${artifactId}::uuid
    )`;
    await tx`DELETE FROM preserve.fact WHERE created_run_id IN (
      SELECT run_id FROM preserve.extraction_run WHERE artifact_id = ${artifactId}::uuid
    )`;
    await tx`DELETE FROM preserve.segment WHERE artifact_id = ${artifactId}::uuid`;
    await tx`DELETE FROM preserve.memory_support WHERE episode_id IN (
      SELECT episode_id FROM preserve.episode WHERE primary_artifact_id = ${artifactId}::uuid
    )`.catch(() => {});
    await tx`DELETE FROM preserve.episode WHERE primary_artifact_id = ${artifactId}::uuid`;
    await tx`DELETE FROM preserve.extraction_run WHERE artifact_id = ${artifactId}::uuid`;

    // ── 1. Resolve/Create Entities ─────────────────────────────────────────
    const entityIdMap = new Map<string, string>(); // "type:name" -> entity_id

    for (const entity of deterministic.entities) {
      const eid = await resolveEntity(tx, entity.name, entity.type);
      entityIdMap.set(`${entity.type}:${entity.name}`, eid);
      entitiesCreated++;
    }

    // ── 2. Create Extraction Run ───────────────────────────────────────────
    const [run] = await tx`
      INSERT INTO preserve.extraction_run (
        artifact_id, pipeline_version, model_name, prompt_version,
        status, started_at
      ) VALUES (
        ${artifactId}::uuid, '0.1.0',
        ${semantic?.model || "deterministic-only"},
        'incident-v1',
        'running'::preserve.extraction_status, now()
      )
      RETURNING run_id
    `;
    const runId = run.run_id;

    // ── 3. Insert Episode ──────────────────────────────────────────────────
    const ep = deterministic.episode;
    const [episodeStart, episodeEnd] = validateDateRange(ep.start_at, ep.end_at);
    const [epRow] = await tx`
      INSERT INTO preserve.episode (
        episode_type, title, scope_path,
        start_at, end_at, severity, outcome, summary,
        primary_artifact_id, tenant
      ) VALUES (
        ${ep.type}, ${ep.title}, ${deterministic.scope_path},
        ${episodeStart},
        ${episodeEnd},
        ${ep.severity || null},
        ${ep.outcome || null},
        ${ep.summary || null},
        ${artifactId}::uuid,
        ${config.tenant}
      )
      RETURNING episode_id
    `;
    episodeId = epRow?.episode_id || null;

    // ── 4. Insert Segments ─────────────────────────────────────────────────
    const segmentIdMap = new Map<string, string>(); // "seg_N" -> segment_id
    const segmentContentMap = new Map<string, string>(); // "seg_N" -> content

    for (const seg of deterministic.segments) {
      const segHash = sha256(seg.content);

      const [segRow] = await tx`
        INSERT INTO preserve.segment (
          artifact_id, ordinal, section_label, content,
          line_start, line_end, source_sha256, scope_path, tenant
        ) VALUES (
          ${artifactId}::uuid, ${seg.ordinal}, ${seg.section_label},
          ${seg.content}, ${seg.line_start}, ${seg.line_end},
          ${segHash}, ${deterministic.scope_path}, ${config.tenant}
        )
        RETURNING segment_id
      `;
      if (segRow) {
        const segKey = `seg_${seg.ordinal}`;
        segmentIdMap.set(segKey, segRow.segment_id);
        segmentContentMap.set(segKey, seg.content);
        segmentsCreated++;
      }
    }

    // ── 4.5. Quality Gate ──────────────────────────────────────────────────
    // Resolve source_type for quality gate validation
    const [artRow] = await tx`
      SELECT source_type::text FROM preserve.artifact WHERE artifact_id = ${artifactId}::uuid
    `;
    const sourceType = artRow?.source_type || "opsvault_incident";

    // Combine all fact candidates for quality gate check. Per-fact `metadata`
    // (e.g. grafana-parser's {service, severity, labels, alert_id}) is carried
    // through so source-type validators can make per-fact decisions.
    const allFactCandidates: FactCandidate[] = [
      ...deterministic.facts.map(f => ({
        subject: f.subject,
        predicate: f.predicate,
        object_value: f.object_value,
        fact_kind: f.fact_kind,
        segment_ids: f.segment_ids,
        confidence: f.confidence,
        metadata: (f as any).metadata,
      })),
      ...(semantic?.facts || []).map(f => ({
        subject: f.subject,
        predicate: f.predicate,
        object_value: f.object_value,
        fact_kind: f.fact_kind,
        segment_ids: f.segment_ids,
        confidence: f.confidence,
        metadata: (f as any).metadata,
      })),
      ...(semantic?.lessons || []).map(l => ({
        subject: "system",
        predicate: "lesson_learned",
        object_value: l.description,
        fact_kind: "lesson",
        segment_ids: l.segment_ids,
        confidence: l.confidence,
      })),
    ];

    // Batch-level metadata fallback: if every deterministic fact carries the
    // same service/severity (as grafana-parser does for a single-annotation
    // batch), promote that to the ctx so validators that only read ctx still
    // succeed. Safe: per-fact metadata takes precedence inside the validator.
    let batchMetadata: Record<string, any> | undefined;
    if (sourceType === "monitoring_alert") {
      const firstMeta = (deterministic.facts.find(
        f => (f as any).metadata,
      ) as any)?.metadata;
      if (firstMeta) {
        batchMetadata = {
          service: firstMeta.service,
          severity: firstMeta.severity,
        };
      }
    }

    qualityGateResult = await checkQualityGate(allFactCandidates, sourceType, tx, {
      sourceKey: deterministic.scope_path,
      episodeId: episodeId || undefined,
      scopePath: deterministic.scope_path,
      metadata: batchMetadata,
    });

    if (qualityGateResult.reasons.length > 0) {
      for (const reason of qualityGateResult.reasons) {
        warnings.push(`[quality-gate] ${reason}`);
      }
    }

    // Build set of passed fact fingerprints for fast lookup
    const passedFingerprints = new Set(
      qualityGateResult.passedFacts.map(f =>
        factFingerprint(f.subject, f.predicate, f.object_value)
      )
    );

    // ── 5. Insert Deterministic Facts ──────────────────────────────────────
    for (const fact of deterministic.facts) {
      // Quality gate: skip if filtered out
      const detFp = factFingerprint(fact.subject, fact.predicate, fact.object_value);
      if (!passedFingerprints.has(detFp)) {
        continue;
      }

      // Resolve subject entity — look up by all possible types
      let subjectEntityId =
        entityIdMap.get(`incident:${fact.subject}`) ||
        entityIdMap.get(`device:${fact.subject}`) ||
        entityIdMap.get(`service:${fact.subject}`);

      if (!subjectEntityId) {
        const eid = await resolveEntity(tx, fact.subject, "incident");
        entityIdMap.set(`incident:${fact.subject}`, eid);
        subjectEntityId = eid;
      }

      // Resolve object entity if it references a known entity name
      let objectEntityId: string | null = null;
      if (typeof fact.object_value === "string") {
        objectEntityId =
          entityIdMap.get(`incident:${fact.object_value}`) ||
          entityIdMap.get(`device:${fact.object_value}`) ||
          entityIdMap.get(`service:${fact.object_value}`) ||
          null;
      }

      const [factValidFrom, factValidTo] = validateDateRange(fact.valid_from, fact.valid_to);
      const fingerprint = factFingerprint(
        fact.subject,
        fact.predicate,
        fact.object_value,
      );

      // Use db.json() for proper jsonb serialization (avoids double-encoding)
      const factPriority = computePriority({
        assertion_class: fact.assertion_class,
        severity: deterministic.episode?.severity,
      });
      const [factRow] = await tx`
        INSERT INTO preserve.fact (
          subject_entity_id, predicate, object_entity_id, object_value,
          fact_kind, assertion_class, confidence, created_run_id,
          valid_from, valid_to, canonical_fingerprint, scope_path,
          episode_id, priority, tenant
        ) VALUES (
          ${subjectEntityId}::uuid, ${fact.predicate},
          ${objectEntityId}::uuid,
          ${db.json(fact.object_value)},
          ${fact.fact_kind}::preserve.fact_kind,
          ${fact.assertion_class}::preserve.assertion_class,
          ${fact.confidence},
          ${runId}::uuid,
          ${factValidFrom},
          ${factValidTo},
          ${fingerprint},
          ${deterministic.scope_path},
          ${episodeId}::uuid,
          ${factPriority},
          ${config.tenant}
        )
        RETURNING fact_id
      `;

      if (factRow) {
        factsCreated++;

        // Link fact to segments via fact_evidence
        for (const segRef of fact.segment_ids) {
          const segId = segmentIdMap.get(segRef);
          const segContent = segmentContentMap.get(segRef);
          if (segId && segContent) {
            const excerpt = segContent.slice(0, 500);
            const excerptHash = sha256(excerpt);
            await tx`
              INSERT INTO preserve.fact_evidence (
                fact_id, segment_id, excerpt, source_sha256,
                extraction_method, excerpt_hash
              )
              VALUES (
                ${factRow.fact_id}::uuid, ${segId}::uuid,
                ${excerpt}, ${contentHash},
                'rule'::preserve.extraction_method,
                ${excerptHash}
              )
              ON CONFLICT (fact_id, segment_id) DO NOTHING
            `;
          }
        }
      }
    }

    // ── 6. Insert Semantic Facts (if available) ────────────────────────────
    if (semantic) {
      for (const fact of semantic.facts) {
        // Quality gate: skip if filtered out
        const semFp = factFingerprint(fact.subject, fact.predicate, fact.object_value);
        if (!passedFingerprints.has(semFp)) {
          continue;
        }

        let subjectEntityId =
          entityIdMap.get(`incident:${fact.subject}`) ||
          entityIdMap.get(`device:${fact.subject}`) ||
          entityIdMap.get(`service:${fact.subject}`);

        if (!subjectEntityId) {
          const eid = await resolveEntity(tx, fact.subject, "config_item");
          entityIdMap.set(`config_item:${fact.subject}`, eid);
          subjectEntityId = eid;
        }

        const fingerprint = factFingerprint(
          fact.subject,
          fact.predicate,
          fact.object_value,
        );

        const semFactPriority = computePriority({
          assertion_class: "single_source_llm",
          severity: deterministic.episode?.severity,
        });
        const [factRow] = await tx`
          INSERT INTO preserve.fact (
            subject_entity_id, predicate, object_value,
            fact_kind, assertion_class, confidence, created_run_id,
            canonical_fingerprint, scope_path, episode_id, priority, tenant
          ) VALUES (
            ${subjectEntityId}::uuid, ${fact.predicate},
            ${db.json(fact.object_value)},
            ${fact.fact_kind}::preserve.fact_kind,
            'single_source_llm'::preserve.assertion_class,
            ${fact.confidence},
            ${runId}::uuid,
            ${fingerprint},
            ${deterministic.scope_path},
            ${episodeId}::uuid,
            ${semFactPriority},
            ${config.tenant}
          )
          RETURNING fact_id
        `;

        if (factRow) {
          factsCreated++;
          for (const segRef of fact.segment_ids) {
            const segId = segmentIdMap.get(segRef);
            const segContent = segmentContentMap.get(segRef);
            if (segId && segContent) {
              const excerpt = segContent.slice(0, 500);
              const excerptHash = sha256(excerpt);
              await tx`
                INSERT INTO preserve.fact_evidence (
                  fact_id, segment_id, excerpt, source_sha256,
                  extraction_method, excerpt_hash
                )
                VALUES (
                  ${factRow.fact_id}::uuid, ${segId}::uuid,
                  ${excerpt}, ${contentHash},
                  'llm'::preserve.extraction_method,
                  ${excerptHash}
                )
                ON CONFLICT (fact_id, segment_id) DO NOTHING
              `;
            }
          }
        }
      }

      // Insert lessons as lesson-type facts
      for (const lesson of semantic.lessons) {
        // Quality gate: skip if filtered out
        const lessonFp = factFingerprint("system", "lesson_learned", lesson.description);
        if (!passedFingerprints.has(lessonFp)) {
          continue;
        }

        let systemEntityId = entityIdMap.get(`service:system`);
        if (!systemEntityId) {
          systemEntityId = await resolveEntity(tx, "system", "service");
          entityIdMap.set(`service:system`, systemEntityId);
        }

        const fingerprint = factFingerprint(
          "system",
          "lesson_learned",
          lesson.description,
        );

        const lessonPriority = computePriority({
          assertion_class: "single_source_llm",
          severity: deterministic.episode?.severity,
        });
        const [factRow] = await tx`
          INSERT INTO preserve.fact (
            subject_entity_id, predicate, object_value,
            fact_kind, assertion_class, confidence, created_run_id,
            canonical_fingerprint, scope_path, episode_id, priority, tenant
          ) VALUES (
            ${systemEntityId}::uuid, 'lesson_learned',
            ${db.json(lesson.description)},
            'lesson'::preserve.fact_kind,
            'single_source_llm'::preserve.assertion_class,
            ${lesson.confidence},
            ${runId}::uuid,
            ${fingerprint},
            ${deterministic.scope_path},
            ${episodeId}::uuid,
            ${lessonPriority},
            ${config.tenant}
          )
          RETURNING fact_id
        `;

        if (factRow) {
          factsCreated++;
          for (const segRef of lesson.segment_ids) {
            const segId = segmentIdMap.get(segRef);
            const segContent = segmentContentMap.get(segRef);
            if (segId && segContent) {
              const excerpt = segContent.slice(0, 500);
              const excerptHash = sha256(excerpt);
              await tx`
                INSERT INTO preserve.fact_evidence (
                  fact_id, segment_id, excerpt, source_sha256,
                  extraction_method, excerpt_hash
                )
                VALUES (
                  ${factRow.fact_id}::uuid, ${segId}::uuid,
                  ${excerpt}, ${contentHash},
                  'llm'::preserve.extraction_method,
                  ${excerptHash}
                )
                ON CONFLICT (fact_id, segment_id) DO NOTHING
              `;
            }
          }
        }
      }
    }

    // ── 7. Update Extraction Run Status ────────────────────────────────────
    await tx`
      UPDATE preserve.extraction_run
      SET status = 'success'::preserve.extraction_status,
          finished_at = now(),
          duration_ms = EXTRACT(EPOCH FROM (now() - started_at))::int * 1000
      WHERE run_id = ${runId}::uuid
    `;

    // ── 8. Update Artifact Flags ───────────────────────────────────────────
    await tx`
      UPDATE preserve.artifact
      SET can_query_raw = true,
          preservation_state = 'extracted'::preserve.preservation_state
      WHERE artifact_id = ${artifactId}::uuid
    `;

    if (semantic && semantic.facts.length > 0) {
      await tx`
        UPDATE preserve.artifact
        SET can_promote_memory = true
        WHERE artifact_id = ${artifactId}::uuid
      `;
    }
  });

  const qualityGate: any = qualityGateResult;

  return {
    entitiesCreated,
    factsCreated,
    segmentsCreated,
    episodeId,
    warnings,
    qualityGate: qualityGate ? {
      duplicateCount: qualityGate.duplicateCount,
      rejectedCount: qualityGate.rejectedCount,
      acceptedCount: qualityGate.acceptedCount,
      updatedCount: qualityGate.updatedCount,
      reasons: qualityGate.reasons,
    } : undefined,
  };
}
