import { createHash } from "crypto";
import type postgres from "postgres";
import { config } from "../config";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type EventFrameFactKind =
  | "state"
  | "cause"
  | "impact"
  | "decision"
  | "remediation"
  | "lesson"
  | "constraint"
  | "config_change"
  | "event";

export interface EventFrameCandidate {
  tenant: string;
  frameFingerprint: string;
  episodeId: string;
  sourceFactId: string;
  eventType: EventFrameFactKind;
  actorEntityId: string;
  action: string;
  targetEntityId: string | null;
  objectValue: JsonValue;
  timeStart: Date | string | null;
  timeEnd: Date | string | null;
  locationEntityId: string | null;
  causeFactId: string | null;
  effectFactId: string | null;
  outcome: string | null;
  confidence: number;
  assertionClass: "deterministic" | "human_curated" | "corroborated_llm";
  evidenceSegmentId: string | null;
  scopePath: string | null;
  createdRunId: string;
  subjectName: string;
  targetName: string | null;
}

export interface EventFrameOptions {
  tenant?: string;
  scope?: string;
  eventType?: string;
  limit?: number;
}

export interface EventFrameInsertResult {
  proposed: number;
  inserted: number;
}

function eventFrameFingerprint(input: {
  tenant: string;
  episodeId: string;
  sourceFactId: string;
  eventType: string;
  action: string;
  scopePath?: string | null;
}): string {
  const raw = [
    "event-frame-v1",
    `tenant=${input.tenant.trim()}`,
    `episode=${input.episodeId.trim().toLowerCase()}`,
    `fact=${input.sourceFactId.trim().toLowerCase()}`,
    `event_type=${input.eventType.trim()}`,
    `action=${input.action.trim()}`,
    `scope=${input.scopePath?.trim() ?? ""}`,
  ].join("|");
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}

function clampConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0.5;
  return Math.max(0, Math.min(1, confidence));
}

function outcomeForFactKind(factKind: EventFrameFactKind, objectValue: unknown): string | null {
  if (!["remediation", "decision", "lesson"].includes(factKind)) return null;
  if (typeof objectValue === "string") return objectValue.slice(0, 500);
  if (objectValue == null) return null;
  return JSON.stringify(objectValue).slice(0, 500);
}

function toJsonValue(value: unknown): JsonValue {
  if (value == null) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export async function findEventFrameCandidates(
  sql: postgres.Sql,
  options: EventFrameOptions = {},
): Promise<EventFrameCandidate[]> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const scope = options.scope;
  const eventType = options.eventType;

  const rows = await sql`
    WITH candidates AS (
      SELECT DISTINCT ON (f.fact_id)
        f.fact_id::text AS fact_id,
        f.episode_id::text AS episode_id,
        f.fact_kind::text AS event_type,
        f.predicate AS action,
        f.subject_entity_id::text AS actor_entity_id,
        subject.canonical_name AS subject_name,
        f.object_entity_id::text AS target_entity_id,
        target.canonical_name AS target_name,
        f.object_value AS object_value,
        COALESCE(f.valid_from, ep.start_at) AS time_start,
        f.valid_to AS time_end,
        f.project_entity_id::text AS location_entity_id,
        CASE WHEN f.fact_kind = 'cause' THEN f.fact_id::text ELSE NULL END AS cause_fact_id,
        CASE WHEN f.fact_kind = 'impact' THEN f.fact_id::text ELSE NULL END AS effect_fact_id,
        f.confidence::float AS confidence,
        f.assertion_class::text AS assertion_class,
        f.created_run_id::text AS created_run_id,
        COALESCE(f.scope_path, ep.scope_path) AS scope_path,
        evidence.segment_id::text AS evidence_segment_id
      FROM preserve.fact f
      JOIN preserve.episode ep
        ON ep.episode_id = f.episode_id
       AND ep.tenant = ${tenant}
      JOIN preserve.entity subject
        ON subject.entity_id = f.subject_entity_id
       AND subject.tenant = ${tenant}
      LEFT JOIN preserve.entity target
        ON target.entity_id = f.object_entity_id
       AND target.tenant = ${tenant}
      LEFT JOIN LATERAL (
        SELECT fe.segment_id
        FROM preserve.fact_evidence fe
        WHERE fe.fact_id = f.fact_id
        ORDER BY fe.weight DESC NULLS LAST, fe.created_at ASC
        LIMIT 1
      ) evidence ON TRUE
      LEFT JOIN preserve.event_frame existing
        ON existing.tenant = ${tenant}
       AND existing.source_fact_id = f.fact_id
      WHERE f.tenant = ${tenant}
        AND f.episode_id IS NOT NULL
        AND f.current_status = 'active'
        AND f.assertion_class IN ('deterministic', 'human_curated', 'corroborated_llm')
        AND f.fact_kind IN ('cause', 'impact', 'decision', 'remediation', 'config_change')
        AND evidence.segment_id IS NOT NULL
        AND existing.event_frame_id IS NULL
        AND (${scope ?? null}::text IS NULL OR COALESCE(f.scope_path, ep.scope_path, '') LIKE (${scope ?? ""} || '%'))
        AND (${eventType ?? null}::text IS NULL OR f.fact_kind::text = ${eventType ?? ""})
      ORDER BY f.fact_id, f.confidence DESC, evidence.segment_id
    )
    SELECT *
    FROM candidates
    ORDER BY time_start NULLS LAST, confidence DESC, fact_id
    LIMIT ${limit}
  `;

  return rows.map((row: any) => {
    const frameFingerprint = eventFrameFingerprint({
      tenant,
      episodeId: row.episode_id,
      sourceFactId: row.fact_id,
      eventType: row.event_type,
      action: row.action,
      scopePath: row.scope_path,
    });
    const objectValue = toJsonValue(row.object_value);
    const eventTypeValue = row.event_type as EventFrameFactKind;
    return {
      tenant,
      frameFingerprint,
      episodeId: row.episode_id,
      sourceFactId: row.fact_id,
      eventType: eventTypeValue,
      actorEntityId: row.actor_entity_id,
      action: row.action,
      targetEntityId: row.target_entity_id ?? null,
      objectValue,
      timeStart: row.time_start ?? null,
      timeEnd: row.time_end ?? null,
      locationEntityId: row.location_entity_id ?? null,
      causeFactId: row.cause_fact_id ?? null,
      effectFactId: row.effect_fact_id ?? null,
      outcome: outcomeForFactKind(eventTypeValue, objectValue),
      confidence: clampConfidence(row.confidence),
      assertionClass: row.assertion_class,
      evidenceSegmentId: row.evidence_segment_id ?? null,
      scopePath: row.scope_path ?? null,
      createdRunId: row.created_run_id,
      subjectName: row.subject_name,
      targetName: row.target_name ?? null,
    };
  });
}

export async function insertEventFrameCandidates(
  candidates: EventFrameCandidate[],
  sql: postgres.Sql,
): Promise<EventFrameInsertResult> {
  let inserted = 0;
  await sql.begin(async (tx) => {
    for (const candidate of candidates) {
      const frameJson = {
        subject: candidate.subjectName,
        predicate: candidate.action,
        object: candidate.objectValue,
        target: candidate.targetName,
        source: "fact",
        source_fact_id: candidate.sourceFactId,
      };
      const rows = await tx`
        INSERT INTO preserve.event_frame (
          tenant,
          frame_fingerprint,
          episode_id,
          source_fact_id,
          event_type,
          actor_entity_id,
          action,
          target_entity_id,
          object_value,
          time_start,
          time_end,
          location_entity_id,
          cause_fact_id,
          effect_fact_id,
          outcome,
          confidence,
          assertion_class,
          evidence_segment_id,
          scope_path,
          frame_json,
          created_run_id
        ) VALUES (
          ${candidate.tenant},
          ${candidate.frameFingerprint},
          ${candidate.episodeId}::uuid,
          ${candidate.sourceFactId}::uuid,
          ${candidate.eventType},
          ${candidate.actorEntityId}::uuid,
          ${candidate.action},
          ${candidate.targetEntityId}::uuid,
          ${sql.json(candidate.objectValue)},
          ${candidate.timeStart},
          ${candidate.timeEnd},
          ${candidate.locationEntityId}::uuid,
          ${candidate.causeFactId}::uuid,
          ${candidate.effectFactId}::uuid,
          ${candidate.outcome},
          ${candidate.confidence},
          ${candidate.assertionClass}::preserve.assertion_class,
          ${candidate.evidenceSegmentId}::uuid,
          ${candidate.scopePath},
          ${sql.json(frameJson)},
          ${candidate.createdRunId}::uuid
        )
        ON CONFLICT (tenant, frame_fingerprint) DO NOTHING
        RETURNING event_frame_id
      `;
      inserted += rows.length;
    }
  });
  return { proposed: candidates.length, inserted };
}
