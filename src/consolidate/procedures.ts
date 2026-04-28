import { createHash } from "crypto";
import type postgres from "postgres";
import { config } from "../config";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ProcedureStepCandidate {
  stepIndex: number;
  action: string;
  expectedResult: string | null;
  sourceFactId: string;
  evidenceSegmentId: string;
  assertionClass: "deterministic" | "human_curated" | "corroborated_llm";
  confidence: number;
  scopePath: string | null;
  stepJson: JsonValue;
  createdRunId: string;
}

export interface ProcedureCandidate {
  tenant: string;
  procedureFingerprint: string;
  title: string;
  summary: string | null;
  sourceFactId: string;
  sourceMemoryId: string | null;
  sourceEpisodeId: string | null;
  scopeEntityId: string;
  projectEntityId: string | null;
  evidenceSegmentId: string;
  assertionClass: "deterministic" | "human_curated" | "corroborated_llm";
  confidence: number;
  lifecycleState: "draft" | "published";
  scopePath: string | null;
  procedureJson: JsonValue;
  createdRunId: string;
  subjectName: string;
  predicate: string;
  steps: ProcedureStepCandidate[];
}

export interface ProcedureCandidateOptions {
  tenant?: string;
  scope?: string;
  limit?: number;
}

export interface ProcedureInsertResult {
  proposed: number;
  inserted: number;
  insertedSteps: number;
}

export function procedureFingerprint(input: {
  tenant: string;
  sourceFactId: string;
  title: string;
  scopePath?: string | null;
}): string {
  const raw = [
    "procedure-v1",
    `tenant=${input.tenant.trim()}`,
    `fact=${input.sourceFactId.trim().toLowerCase()}`,
    `title=${input.title.trim().toLowerCase()}`,
    `scope=${input.scopePath?.trim() ?? ""}`,
  ].join("|");
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}

function clampConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0.5;
  return Math.max(0, Math.min(1, confidence));
}

function toJsonValue(value: unknown): JsonValue {
  if (value == null) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function textFromObjectValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "action" in item) {
        return String((item as { action?: unknown }).action ?? "");
      }
      return JSON.stringify(item);
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["procedure", "steps", "action", "summary", "text"]) {
      if (record[key] != null) return textFromObjectValue(record[key]);
    }
    return JSON.stringify(value);
  }
  return String(value ?? "").trim();
}

function normalizeStepText(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*(?:step\s+\d+\s*[:.)-])\s*/i, "")
    .trim();
}

export function extractProcedureSteps(value: unknown): Array<{ action: string; expectedResult: string | null }> {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") {
        const action = normalizeStepText(item);
        return action ? [{ action, expectedResult: null }] : [];
      }
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const action = normalizeStepText(String(record.action ?? record.step ?? record.command ?? ""));
        if (!action) return [];
        const expected = record.expected_result ?? record.expectedResult ?? record.result ?? null;
        return [{ action, expectedResult: expected == null ? null : String(expected) }];
      }
      return [];
    });
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.steps)) return extractProcedureSteps(record.steps);
  }

  const text = textFromObjectValue(value);
  if (!text) return [];

  const listSteps = text
    .split(/\r?\n/)
    .map(normalizeStepText)
    .filter(Boolean)
    .filter((line) => line.length >= 4);

  if (listSteps.length > 1) {
    return listSteps.map((action) => ({ action, expectedResult: null }));
  }

  return [{ action: text, expectedResult: null }];
}

function titleForProcedure(subject: string, predicate: string, value: unknown): string {
  const text = textFromObjectValue(value).replace(/\s+/g, " ");
  const suffix = text ? `: ${text.slice(0, 80)}` : "";
  return `Procedure: ${subject} ${predicate}${suffix}`;
}

export async function findProcedureCandidates(
  sql: postgres.Sql,
  options: ProcedureCandidateOptions = {},
): Promise<ProcedureCandidate[]> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const scope = options.scope;

  const rows = await sql`
    WITH candidates AS (
      SELECT DISTINCT ON (f.fact_id)
        f.fact_id::text AS fact_id,
        f.episode_id::text AS episode_id,
        f.subject_entity_id::text AS scope_entity_id,
        f.project_entity_id::text AS project_entity_id,
        subject.canonical_name AS subject_name,
        f.predicate,
        f.object_value,
        f.confidence::float AS confidence,
        f.assertion_class::text AS assertion_class,
        f.created_run_id::text AS created_run_id,
        f.scope_path,
        evidence.segment_id::text AS evidence_segment_id
      FROM preserve.fact f
      JOIN preserve.entity subject
        ON subject.entity_id = f.subject_entity_id
       AND subject.tenant = ${tenant}
      LEFT JOIN preserve.episode ep
        ON ep.episode_id = f.episode_id
       AND ep.tenant = ${tenant}
      LEFT JOIN LATERAL (
        SELECT fe.segment_id
        FROM preserve.fact_evidence fe
        WHERE fe.fact_id = f.fact_id
        ORDER BY fe.weight DESC NULLS LAST, fe.created_at ASC
        LIMIT 1
      ) evidence ON TRUE
      LEFT JOIN preserve.procedure existing
        ON existing.tenant = ${tenant}
       AND existing.source_fact_id = f.fact_id
      WHERE f.tenant = ${tenant}
        AND f.current_status = 'active'
        AND f.assertion_class IN ('deterministic', 'human_curated', 'corroborated_llm')
        AND f.fact_kind IN ('remediation', 'config_change', 'decision')
        AND evidence.segment_id IS NOT NULL
        AND existing.procedure_id IS NULL
        AND (${scope ?? null}::text IS NULL OR COALESCE(f.scope_path, ep.scope_path, '') LIKE (${scope ?? ""} || '%'))
      ORDER BY f.fact_id, f.confidence DESC, evidence.segment_id
    )
    SELECT *
    FROM candidates
    ORDER BY confidence DESC, fact_id
    LIMIT ${limit}
  `;

  return rows.flatMap((row: any) => {
    const steps = extractProcedureSteps(row.object_value);
    if (steps.length === 0) return [];

    const confidence = clampConfidence(row.confidence);
    const title = titleForProcedure(row.subject_name, row.predicate, row.object_value);
    const sourceFactId = row.fact_id;
    const evidenceSegmentId = row.evidence_segment_id;
    const assertionClass = row.assertion_class;
    const createdRunId = row.created_run_id;
    const scopePath = row.scope_path ?? null;
    const procedureSteps = steps.map((step, index) => ({
      stepIndex: index + 1,
      action: step.action,
      expectedResult: step.expectedResult,
      sourceFactId,
      evidenceSegmentId,
      assertionClass,
      confidence,
      scopePath,
      stepJson: toJsonValue(step),
      createdRunId,
    }));

    return [{
      tenant,
      procedureFingerprint: procedureFingerprint({ tenant, sourceFactId, title, scopePath }),
      title,
      summary: textFromObjectValue(row.object_value).slice(0, 500) || null,
      sourceFactId,
      sourceMemoryId: null,
      sourceEpisodeId: row.episode_id ?? null,
      scopeEntityId: row.scope_entity_id,
      projectEntityId: row.project_entity_id ?? null,
      evidenceSegmentId,
      assertionClass,
      confidence,
      lifecycleState: "draft" as const,
      scopePath,
      procedureJson: {
        source: "fact",
        subject: row.subject_name,
        predicate: row.predicate,
        object: toJsonValue(row.object_value),
      },
      createdRunId,
      subjectName: row.subject_name,
      predicate: row.predicate,
      steps: procedureSteps,
    }];
  });
}

export async function insertProcedureCandidates(
  candidates: ProcedureCandidate[],
  sql: postgres.Sql,
): Promise<ProcedureInsertResult> {
  let inserted = 0;
  let insertedSteps = 0;

  await sql.begin(async (tx) => {
    for (const candidate of candidates) {
      const rows = await tx`
        INSERT INTO preserve.procedure (
          tenant,
          procedure_fingerprint,
          title,
          summary,
          source_fact_id,
          source_memory_id,
          source_episode_id,
          scope_entity_id,
          project_entity_id,
          evidence_segment_id,
          assertion_class,
          confidence,
          lifecycle_state,
          scope_path,
          procedure_json,
          created_run_id
        ) VALUES (
          ${candidate.tenant},
          ${candidate.procedureFingerprint},
          ${candidate.title},
          ${candidate.summary},
          ${candidate.sourceFactId}::uuid,
          ${candidate.sourceMemoryId}::uuid,
          ${candidate.sourceEpisodeId}::uuid,
          ${candidate.scopeEntityId}::uuid,
          ${candidate.projectEntityId}::uuid,
          ${candidate.evidenceSegmentId}::uuid,
          ${candidate.assertionClass}::preserve.assertion_class,
          ${candidate.confidence},
          ${candidate.lifecycleState}::preserve.lifecycle_state,
          ${candidate.scopePath},
          ${sql.json(candidate.procedureJson)},
          ${candidate.createdRunId}::uuid
        )
        ON CONFLICT (tenant, procedure_fingerprint) DO NOTHING
        RETURNING procedure_id
      `;

      if (rows.length === 0) continue;
      inserted += 1;
      const procedureId = rows[0].procedure_id;

      for (const step of candidate.steps) {
        const stepRows = await tx`
          INSERT INTO preserve.procedure_step (
            procedure_id,
            tenant,
            step_index,
            action,
            expected_result,
            source_fact_id,
            evidence_segment_id,
            assertion_class,
            confidence,
            scope_path,
            step_json,
            created_run_id
          ) VALUES (
            ${procedureId}::uuid,
            ${candidate.tenant},
            ${step.stepIndex},
            ${step.action},
            ${step.expectedResult},
            ${step.sourceFactId}::uuid,
            ${step.evidenceSegmentId}::uuid,
            ${step.assertionClass}::preserve.assertion_class,
            ${step.confidence},
            ${step.scopePath},
            ${sql.json(step.stepJson)},
            ${step.createdRunId}::uuid
          )
          ON CONFLICT (procedure_id, step_index) DO NOTHING
          RETURNING procedure_step_id
        `;
        insertedSteps += stepRows.length;
      }
    }
  });

  return { proposed: candidates.length, inserted, insertedSteps };
}
