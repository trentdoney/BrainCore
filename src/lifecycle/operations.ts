import { createHash } from "crypto";
import type postgres from "postgres";
import { config } from "../config";
import {
  assertAdminStatusMutationAllowed,
  assertFeedbackMutationAllowed,
  assertLifecycleEventCanCreateTarget,
  feedbackCreatesReview,
} from "./evidence-boundary";
import {
  type LifecycleCueExtractionMethod,
  type LifecycleCueType,
  type FeedbackSignal,
  type JsonObject,
  type LifecycleEventType,
  type LifecycleStatus,
  type LifecycleTargetKind,
  isLifecycleCueExtractionMethod,
  isLifecycleCueType,
  isTargetKind,
} from "./types";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type SqlExecutor = postgres.Sql | postgres.TransactionSql;

const DEFAULT_CONFIG_VERSION = "braincore-lifecycle-v1";
const SCORE_DELTAS: Record<FeedbackSignal, { salience: number; strength: number; stability: number; quality: number }> = {
  retrieved_not_injected: { salience: -0.01, strength: 0, stability: 0, quality: 0 },
  injected_referenced: { salience: 0.05, strength: 0.04, stability: 0.02, quality: 0.03 },
  injected_ignored: { salience: -0.02, strength: -0.01, stability: 0, quality: -0.01 },
  injected_contradicted: { salience: 0.03, strength: -0.08, stability: -0.08, quality: -0.10 },
  led_to_success: { salience: 0.06, strength: 0.05, stability: 0.03, quality: 0.04 },
  led_to_failure: { salience: 0.02, strength: -0.05, stability: -0.04, quality: -0.07 },
  user_corrected: { salience: 0.06, strength: -0.06, stability: -0.05, quality: -0.08 },
  user_confirmed: { salience: 0.04, strength: 0.06, stability: 0.04, quality: 0.06 },
  admin_suppressed: { salience: -0.20, strength: -0.20, stability: 0, quality: -0.20 },
  admin_promoted: { salience: 0.15, strength: 0.10, stability: 0.05, quality: 0.10 },
};

export interface LifecycleEventInput {
  tenant?: string;
  eventId: string;
  idempotencyKey?: string;
  eventType: LifecycleEventType;
  sourceService: string;
  scopePath?: string | null;
  sessionKey?: string | null;
  taskId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  targetKind?: LifecycleTargetKind | null;
  targetId?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  occurredAt?: Date | string | null;
  payload?: JsonObject;
  evidenceRefs?: unknown[];
}

export interface LifecycleEventRow {
  outboxId: string;
  tenant: string;
  eventId: string;
  eventType: LifecycleEventType;
  sourceService: string;
  status: string;
  targetKind: LifecycleTargetKind | null;
  targetId: string | null;
  attemptCount: number;
  receivedAt: string;
}

interface LifecycleEventDbRow {
  outbox_id: string;
  tenant: string;
  event_id: string;
  event_type: LifecycleEventType;
  source_service: string;
  status: string;
  target_kind: LifecycleTargetKind | null;
  target_id: string | null;
  attempt_count: number | string;
  received_at: string;
}

interface LifecycleTargetIntelligenceRow {
  intelligence_id: string;
  tenant: string;
  target_kind: LifecycleTargetKind;
  target_id: string;
  source_derivation_type: string;
  horizon: string;
  lifecycle_status: LifecycleStatus;
  salience: number | string;
  strength: number | string;
  stability: number | string;
  quality_score: number | string;
  summary_fidelity_score: number | string | null;
  support_count: number | string;
  contradiction_count: number | string;
  lock_version: number | string;
}

export interface FeedbackInput {
  tenant?: string;
  targetKind: LifecycleTargetKind;
  targetId: string;
  signal: FeedbackSignal;
  actorType?: string | null;
  actorId?: string | null;
  scopePath?: string | null;
  contextAuditId?: string | null;
  outcome?: string | null;
  evidenceRefs?: unknown[];
  details?: JsonObject;
  requestedNativeMutation?: boolean;
}

export interface ContextRecallAuditInput {
  tenant?: string;
  trigger: "session_start" | "mission_start" | "pre_model_call" | "tool_failure" | "task_failure" | "context_compacted" | "memory_protocol";
  mode: "off" | "shadow" | "eval" | "default_on";
  injected?: boolean;
  scopePath?: string | null;
  sessionKey?: string | null;
  taskId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  goal?: string | null;
  cues?: unknown[];
  relevanceReason?: string | null;
  queryPlan?: JsonObject;
  retrieved?: unknown[];
  promptPackage?: unknown[];
  omitted?: unknown[];
  totalTokens?: number;
  maxTokens: number;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

export class LifecycleTargetNotFoundError extends Error {
  readonly code = "LIFECYCLE_TARGET_NOT_FOUND";

  constructor(targetKind: LifecycleTargetKind, targetId: string) {
    super(`Lifecycle target not found: ${targetKind}:${targetId}`);
    this.name = "LifecycleTargetNotFoundError";
  }
}

function hasSegmentEvidence(evidenceRefs: unknown[]): boolean {
  return evidenceRefs.some((ref) => {
    return Boolean(ref && typeof ref === "object" && "segment_id" in ref);
  });
}

function toLifecycleEvent(row: LifecycleEventDbRow): LifecycleEventRow {
  return {
    outboxId: String(row.outbox_id),
    tenant: String(row.tenant),
    eventId: String(row.event_id),
    eventType: row.event_type,
    sourceService: String(row.source_service),
    status: String(row.status),
    targetKind: row.target_kind ?? null,
    targetId: row.target_id == null ? null : String(row.target_id),
    attemptCount: Number(row.attempt_count ?? 0),
    receivedAt: String(row.received_at),
  };
}

function cueHash(input: { cueText: string; cueType: string }): string {
  return createHash("sha256")
    .update(`${input.cueType.trim().toLowerCase()}\x1f${input.cueText.trim().toLowerCase()}`)
    .digest("hex");
}

export function normalizeLifecycleCueType(value: unknown): LifecycleCueType {
  return typeof value === "string" && isLifecycleCueType(value) ? value : "goal";
}

export function normalizeLifecycleCueExtractionMethod(value: unknown): LifecycleCueExtractionMethod {
  return typeof value === "string" && isLifecycleCueExtractionMethod(value) ? value : "manual";
}

async function ensureTargetIntelligence(
  sql: SqlExecutor,
  input: {
    tenant: string;
    targetKind: LifecycleTargetKind;
    targetId: string;
    sourceDerivationType?: string;
    horizon?: string;
    status?: LifecycleStatus;
  },
): Promise<LifecycleTargetIntelligenceRow> {
  await assertLifecycleTargetExists(sql, {
    tenant: input.tenant,
    targetKind: input.targetKind,
    targetId: input.targetId,
  });

  await sql`
    INSERT INTO preserve.lifecycle_target_intelligence (
      tenant,
      target_kind,
      target_id,
      source_derivation_type,
      horizon,
      lifecycle_status
    )
    VALUES (
      ${input.tenant},
      ${input.targetKind},
      ${input.targetId},
      ${input.sourceDerivationType ?? "system_inferred"},
      ${input.horizon ?? "semantic"},
      ${input.status ?? "active"}
    )
    ON CONFLICT (tenant, target_kind, target_id) DO NOTHING
  `;

  const rows = await sql`
    SELECT *
    FROM preserve.lifecycle_target_intelligence
    WHERE tenant = ${input.tenant}
      AND target_kind = ${input.targetKind}
      AND target_id = ${input.targetId}
    FOR UPDATE
  `;
  if (!rows[0]) {
    throw new Error("Lifecycle target intelligence was not created or loaded.");
  }
  return rows[0] as LifecycleTargetIntelligenceRow;
}

export async function lifecycleTargetExists(
  sql: SqlExecutor,
  input: { tenant: string; targetKind: LifecycleTargetKind; targetId: string },
): Promise<boolean> {
  let rows: any[] = [];
  if (input.targetKind === "fact") {
    rows = await sql`
      SELECT 1
      FROM preserve.fact
      WHERE tenant = ${input.tenant}
        AND fact_id = ${input.targetId}
      LIMIT 1
    `;
  } else if (input.targetKind === "memory") {
    rows = await sql`
      SELECT 1
      FROM preserve.memory
      WHERE tenant = ${input.tenant}
        AND memory_id = ${input.targetId}
      LIMIT 1
    `;
  } else if (input.targetKind === "procedure") {
    rows = await sql`
      SELECT 1
      FROM preserve.procedure
      WHERE tenant = ${input.tenant}
        AND procedure_id = ${input.targetId}
      LIMIT 1
    `;
  } else if (input.targetKind === "event_frame") {
    rows = await sql`
      SELECT 1
      FROM preserve.event_frame
      WHERE tenant = ${input.tenant}
        AND event_frame_id = ${input.targetId}
      LIMIT 1
    `;
  } else {
    rows = await sql`
      SELECT 1
      FROM preserve.working_memory
      WHERE tenant = ${input.tenant}
        AND working_memory_id = ${input.targetId}
      LIMIT 1
    `;
  }
  return rows.length > 0;
}

async function assertLifecycleTargetExists(
  sql: SqlExecutor,
  input: { tenant: string; targetKind: LifecycleTargetKind; targetId: string },
): Promise<void> {
  if (!await lifecycleTargetExists(sql, input)) {
    throw new LifecycleTargetNotFoundError(input.targetKind, input.targetId);
  }
}

async function writeAudit(
  sql: SqlExecutor,
  input: {
    tenant: string;
    action: string;
    targetKind?: LifecycleTargetKind | null;
    targetId?: string | null;
    actorType?: string | null;
    actorId?: string | null;
    outboxId?: string | null;
    feedbackId?: string | null;
    contextAuditId?: string | null;
    reason?: string | null;
    beforeState?: unknown;
    afterState?: unknown;
    details?: unknown;
  },
): Promise<void> {
  await sql`
    INSERT INTO preserve.lifecycle_audit_log (
      tenant,
      actor_type,
      actor_id,
      action,
      target_kind,
      target_id,
      outbox_id,
      feedback_id,
      context_audit_id,
      reason,
      before_state,
      after_state,
      details
    )
    VALUES (
      ${input.tenant},
      ${input.actorType ?? null},
      ${input.actorId ?? null},
      ${input.action},
      ${input.targetKind ?? null},
      ${input.targetId ?? null},
      ${input.outboxId ?? null},
      ${input.feedbackId ?? null},
      ${input.contextAuditId ?? null},
      ${input.reason ?? null},
      ${input.beforeState == null ? null : sql.json(toJson(input.beforeState))},
      ${input.afterState == null ? null : sql.json(toJson(input.afterState))},
      ${sql.json(toJson(input.details ?? {}))}
    )
  `;
}

export async function enqueueLifecycleEvent(
  sql: postgres.Sql,
  input: LifecycleEventInput,
): Promise<LifecycleEventRow> {
  const tenant = input.tenant ?? config.tenant;
  if ((input.targetKind && !input.targetId) || (!input.targetKind && input.targetId)) {
    throw new Error("Lifecycle target_kind and target_id must be supplied together.");
  }
  if (input.targetKind && input.targetId) {
    await assertLifecycleTargetExists(sql, {
      tenant,
      targetKind: input.targetKind,
      targetId: input.targetId,
    });
  }
  const producedTargetKind = input.payload?.producedTargetKind;
  const producedTargetId = input.payload?.producedTargetId;
  if (
    (typeof producedTargetKind === "string" && typeof producedTargetId !== "string")
    || (typeof producedTargetKind !== "string" && typeof producedTargetId === "string")
  ) {
    throw new Error("producedTargetKind and producedTargetId must be supplied together.");
  }
  if (typeof producedTargetKind === "string") {
    if (!isTargetKind(producedTargetKind)) {
      throw new Error(`Invalid producedTargetKind: ${producedTargetKind}`);
    }
    assertLifecycleEventCanCreateTarget({
      eventType: input.eventType,
      targetKind: producedTargetKind,
      evidenceRefs: input.evidenceRefs,
    });
  }
  const idempotencyKey = input.idempotencyKey ?? `${input.sourceService}:${input.eventId}`;
  const rows = await sql`
    INSERT INTO preserve.lifecycle_outbox (
      tenant,
      event_id,
      idempotency_key,
      event_type,
      source_service,
      scope_path,
      session_key,
      task_id,
      trace_id,
      span_id,
      target_kind,
      target_id,
      actor_type,
      actor_id,
      occurred_at,
      payload,
      evidence_refs,
      produced_target_kind,
      produced_target_id
    )
    VALUES (
      ${tenant},
      ${input.eventId},
      ${idempotencyKey},
      ${input.eventType},
      ${input.sourceService},
      ${input.scopePath ?? null},
      ${input.sessionKey ?? null},
      ${input.taskId ?? null},
      ${input.traceId ?? null},
      ${input.spanId ?? null},
      ${input.targetKind ?? null},
      ${input.targetId ?? null},
      ${input.actorType ?? null},
      ${input.actorId ?? null},
      ${input.occurredAt ?? null},
      ${sql.json(toJson(input.payload ?? {}))},
      ${sql.json(toJson(input.evidenceRefs ?? []))},
      ${typeof producedTargetKind === "string" ? producedTargetKind : null},
      ${typeof producedTargetId === "string" ? producedTargetId : null}
    )
    ON CONFLICT (tenant, idempotency_key) DO UPDATE
      SET received_at = preserve.lifecycle_outbox.received_at
    RETURNING *
  `;
  return toLifecycleEvent(rows[0] as LifecycleEventDbRow);
}

export async function listLifecycleEvents(
  sql: postgres.Sql,
  options: { tenant?: string; status?: string | null; limit?: number } = {},
): Promise<LifecycleEventRow[]> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const rows = await sql`
    SELECT *
    FROM preserve.lifecycle_outbox
    WHERE tenant = ${tenant}
      AND (${options.status ?? null}::text IS NULL OR status = ${options.status ?? ""})
    ORDER BY received_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => toLifecycleEvent(row as LifecycleEventDbRow));
}

export async function claimLifecycleEvents(
  sql: postgres.Sql,
  options: { tenant?: string; workerId: string; limit?: number } = { workerId: "braincore-cli" },
): Promise<LifecycleEventRow[]> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(options.limit ?? 25, 250));
  const rows = await sql`
    WITH claimable AS (
      SELECT outbox_id
      FROM preserve.lifecycle_outbox
      WHERE tenant = ${tenant}
        AND (
          status = 'pending'
          OR (
            status = 'processing'
            AND claimed_at < now() - (claim_timeout_ms::text || ' milliseconds')::interval
          )
          OR (
            status = 'failed'
            AND attempt_count < max_attempts
            AND next_attempt_at <= now()
          )
        )
      ORDER BY received_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE preserve.lifecycle_outbox o
    SET status = 'processing',
        claimed_at = now(),
        claimed_by = ${options.workerId},
        attempt_count = attempt_count + 1
    FROM claimable
    WHERE o.outbox_id = claimable.outbox_id
    RETURNING o.*
  `;
  return rows.map((row) => toLifecycleEvent(row as LifecycleEventDbRow));
}

async function processOneLifecycleEvent(sql: postgres.Sql, outboxId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT *
      FROM preserve.lifecycle_outbox
      WHERE outbox_id = ${outboxId}
      FOR UPDATE
    `;
    const event = rows[0];
    if (!event || event.status !== "processing") return;
    const evidenceRefs = Array.isArray(event.evidence_refs) ? event.evidence_refs : [];

    if (event.produced_target_kind && event.produced_target_id) {
      assertLifecycleEventCanCreateTarget({
        eventType: event.event_type,
        targetKind: event.produced_target_kind,
        evidenceRefs,
      });
      await assertLifecycleTargetExists(tx, {
        tenant: event.tenant,
        targetKind: event.produced_target_kind,
        targetId: String(event.produced_target_id),
      });
    }

    if (event.target_kind && event.target_id) {
      const intelligence = await ensureTargetIntelligence(tx, {
        tenant: event.tenant,
        targetKind: event.target_kind,
        targetId: String(event.target_id),
        sourceDerivationType: "observed",
      });

      const cues = Array.isArray(event.payload?.cues) ? event.payload.cues : [];
      for (const rawCue of cues.slice(0, 25)) {
        const cue = typeof rawCue === "string" ? { text: rawCue } : rawCue;
        const cueText = typeof cue?.text === "string" ? cue.text.trim() : "";
        if (!cueText) continue;
        const cueType = normalizeLifecycleCueType(cue?.type);
        const extractionMethod = normalizeLifecycleCueExtractionMethod(cue?.method);
        await tx`
          INSERT INTO preserve.lifecycle_cue (
            tenant,
            target_kind,
            target_id,
            cue_text,
            cue_hash,
            cue_type,
            extraction_method,
            confidence,
            evidence_ref
          )
          VALUES (
            ${event.tenant},
            ${event.target_kind},
            ${event.target_id},
            ${cueText},
            ${cueHash({ cueText, cueType })},
            ${cueType},
            ${extractionMethod},
            ${Math.max(0, Math.min(Number(cue?.confidence ?? 0.7), 1))},
            ${sql.json(toJson(cue?.evidence_ref ?? null))}
          )
          ON CONFLICT (tenant, target_kind, target_id, cue_hash) DO UPDATE
            SET usefulness_score = GREATEST(preserve.lifecycle_cue.usefulness_score, EXCLUDED.usefulness_score),
                last_used_at = now()
        `;
      }

      await writeAudit(tx, {
        tenant: event.tenant,
        action: "lifecycle_event_processed",
        targetKind: event.target_kind,
        targetId: String(event.target_id),
        actorType: event.actor_type,
        actorId: event.actor_id,
        outboxId,
        afterState: intelligence,
        details: { event_type: event.event_type, source_service: event.source_service },
      });
    } else if (event.event_type === "fact_inserted" || event.event_type === "memory_written") {
      if (!hasSegmentEvidence(evidenceRefs)) {
        throw new Error(`${event.event_type} lifecycle event requires target and segment evidence.`);
      }
    } else {
      await writeAudit(tx, {
        tenant: event.tenant,
        action: "lifecycle_event_observed",
        actorType: event.actor_type,
        actorId: event.actor_id,
        outboxId,
        details: { event_type: event.event_type, source_service: event.source_service },
      });
    }

    await tx`
      UPDATE preserve.lifecycle_outbox
      SET status = 'completed',
          completed_at = now(),
          error_summary = NULL
      WHERE outbox_id = ${outboxId}
    `;
  });
}

async function failLifecycleEvent(sql: postgres.Sql, outboxId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sql`
    UPDATE preserve.lifecycle_outbox
    SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead_letter' ELSE 'failed' END,
        next_attempt_at = now() + (LEAST(3600, POWER(2, attempt_count)::int * 30)::text || ' seconds')::interval,
        error_summary = ${message.slice(0, 1000)},
        error_history = COALESCE(error_history, '[]'::jsonb) || ${sql.json(toJson([{ at: new Date().toISOString(), message }]))},
        dead_lettered_at = CASE WHEN attempt_count >= max_attempts THEN now() ELSE dead_lettered_at END,
        dead_letter_retained_until = CASE WHEN attempt_count >= max_attempts THEN now() + interval '90 days' ELSE dead_letter_retained_until END
    WHERE outbox_id = ${outboxId}
  `;
}

export async function processLifecycleEvents(
  sql: postgres.Sql,
  options: { tenant?: string; workerId?: string; limit?: number } = {},
): Promise<{ claimed: number; completed: number; failed: number }> {
  const events = await claimLifecycleEvents(sql, {
    tenant: options.tenant,
    workerId: options.workerId ?? "braincore-cli",
    limit: options.limit,
  });
  let completed = 0;
  let failed = 0;
  for (const event of events) {
    try {
      await processOneLifecycleEvent(sql, event.outboxId);
      completed += 1;
    } catch (error) {
      await failLifecycleEvent(sql, event.outboxId, error);
      failed += 1;
    }
  }
  return { claimed: events.length, completed, failed };
}

export async function recordLifecycleFeedback(
  sql: postgres.Sql,
  input: FeedbackInput,
): Promise<{ feedbackId: string; lifecycleStatus: string; qualityScore: number }> {
  assertFeedbackMutationAllowed(input);
  const tenant = input.tenant ?? config.tenant;
  return await sql.begin(async (tx) => {
    const before = await ensureTargetIntelligence(tx, {
      tenant,
      targetKind: input.targetKind,
      targetId: input.targetId,
      sourceDerivationType: "feedback_derived",
      status: feedbackCreatesReview(input.signal) ? "review_required" : "active",
    });
    const delta = SCORE_DELTAS[input.signal];
    const next = {
      salience: clampScore(Number(before.salience) + delta.salience),
      strength: clampScore(Number(before.strength) + delta.strength),
      stability: clampScore(Number(before.stability) + delta.stability),
      quality: clampScore(Number(before.quality_score) + delta.quality),
      status: feedbackCreatesReview(input.signal) ? "review_required" : before.lifecycle_status,
    };

    const feedbackRows = await tx`
      INSERT INTO preserve.lifecycle_feedback_event (
        tenant,
        target_kind,
        target_id,
        context_audit_id,
        signal,
        outcome,
        score_delta,
        actor_type,
        actor_id,
        scope_path,
        evidence_refs,
        details
      )
      VALUES (
        ${tenant},
        ${input.targetKind},
        ${input.targetId},
        ${input.contextAuditId ?? null},
        ${input.signal},
        ${input.outcome ?? null},
        ${sql.json(toJson(delta))},
        ${input.actorType ?? null},
        ${input.actorId ?? null},
        ${input.scopePath ?? null},
        ${sql.json(toJson(input.evidenceRefs ?? []))},
        ${sql.json(toJson(input.details ?? {}))}
      )
      RETURNING feedback_id
    `;

    const updatedRows = await tx`
      UPDATE preserve.lifecycle_target_intelligence
      SET salience = ${next.salience},
          strength = ${next.strength},
          stability = ${next.stability},
          quality_score = ${next.quality},
          lifecycle_status = ${next.status},
          last_reinforced_at = now(),
          support_count = support_count + CASE WHEN ${input.signal} IN ('injected_referenced','led_to_success','user_confirmed','admin_promoted') THEN 1 ELSE 0 END,
          contradiction_count = contradiction_count + CASE WHEN ${input.signal} IN ('injected_contradicted','led_to_failure','user_corrected') THEN 1 ELSE 0 END,
          lock_version = lock_version + 1
      WHERE tenant = ${tenant}
        AND target_kind = ${input.targetKind}
        AND target_id = ${input.targetId}
      RETURNING *
    `;
    const after = updatedRows[0] as LifecycleTargetIntelligenceRow;
    const feedbackId = String(feedbackRows[0].feedback_id);

    await tx`
      INSERT INTO preserve.lifecycle_score_audit (
        tenant,
        target_kind,
        target_id,
        trigger_type,
        previous_salience,
        new_salience,
        previous_strength,
        new_strength,
        previous_stability,
        new_stability,
        previous_quality_score,
        new_quality_score,
        factors,
        feedback_id
      )
      VALUES (
        ${tenant},
        ${input.targetKind},
        ${input.targetId},
        'feedback',
        ${before.salience},
        ${after.salience},
        ${before.strength},
        ${after.strength},
        ${before.stability},
        ${after.stability},
        ${before.quality_score},
        ${after.quality_score},
        ${sql.json(toJson({ signal: input.signal, delta }))},
        ${feedbackId}
      )
    `;

    await writeAudit(tx, {
      tenant,
      action: "feedback_recorded",
      targetKind: input.targetKind,
      targetId: input.targetId,
      actorType: input.actorType,
      actorId: input.actorId,
      feedbackId,
      beforeState: before,
      afterState: after,
      details: { signal: input.signal },
    });

    return {
      feedbackId,
      lifecycleStatus: String(after.lifecycle_status),
      qualityScore: Number(after.quality_score),
    };
  });
}

export async function setLifecycleStatus(
  sql: postgres.Sql,
  input: {
    tenant?: string;
    targetKind: LifecycleTargetKind;
    targetId: string;
    status: LifecycleStatus;
    reason: string;
    actorType?: string | null;
    actorId?: string | null;
    requestedNativeMutation?: boolean;
  },
): Promise<{ lifecycleStatus: LifecycleStatus; lockVersion: number }> {
  assertAdminStatusMutationAllowed(input);
  const tenant = input.tenant ?? config.tenant;
  return await sql.begin(async (tx) => {
    const before = await ensureTargetIntelligence(tx, {
      tenant,
      targetKind: input.targetKind,
      targetId: input.targetId,
      sourceDerivationType: "corrected_by_user",
      status: input.status,
    });
    const rows = await tx`
      UPDATE preserve.lifecycle_target_intelligence
      SET lifecycle_status = ${input.status},
          lock_version = lock_version + 1
      WHERE tenant = ${tenant}
        AND target_kind = ${input.targetKind}
        AND target_id = ${input.targetId}
      RETURNING *
    `;
    const after = rows[0] as LifecycleTargetIntelligenceRow;
    await writeAudit(tx, {
      tenant,
      action: "admin_status_change",
      targetKind: input.targetKind,
      targetId: input.targetId,
      actorType: input.actorType ?? "admin",
      actorId: input.actorId ?? null,
      reason: input.reason,
      beforeState: before,
      afterState: after,
    });
    return {
      lifecycleStatus: after.lifecycle_status,
      lockVersion: Number(after.lock_version),
    };
  });
}

export async function backfillLifecycleIntelligence(
  sql: postgres.Sql,
  options: { tenant?: string; targetKind?: LifecycleTargetKind | "all"; limit?: number } = {},
): Promise<{ inserted: number }> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(options.limit ?? 1000, 10000));
  const targetKind = options.targetKind ?? "all";
  let inserted = 0;

  async function insertFromFact(): Promise<void> {
    const rows = await sql`
      WITH candidates AS (
        SELECT f.tenant, f.fact_id AS target_id
        FROM preserve.fact f
        WHERE f.tenant = ${tenant}
          AND NOT EXISTS (
            SELECT 1
            FROM preserve.lifecycle_target_intelligence lti
            WHERE lti.tenant = f.tenant
              AND lti.target_kind = 'fact'
              AND lti.target_id = f.fact_id
          )
        ORDER BY f.fact_id
        LIMIT ${limit}
      )
      INSERT INTO preserve.lifecycle_target_intelligence (
        tenant, target_kind, target_id, source_derivation_type, horizon, lifecycle_status
      )
      SELECT tenant, 'fact', target_id, 'imported_knowledge', 'semantic', 'active'
      FROM candidates
      ON CONFLICT (tenant, target_kind, target_id) DO NOTHING
      RETURNING intelligence_id
    `;
    inserted += rows.length;
  }

  async function insertFromMemory(): Promise<void> {
    const rows = await sql`
      WITH candidates AS (
        SELECT m.tenant, m.memory_id AS target_id
        FROM preserve.memory m
        WHERE m.tenant = ${tenant}
          AND NOT EXISTS (
            SELECT 1
            FROM preserve.lifecycle_target_intelligence lti
            WHERE lti.tenant = m.tenant
              AND lti.target_kind = 'memory'
              AND lti.target_id = m.memory_id
          )
        ORDER BY m.memory_id
        LIMIT ${limit}
      )
      INSERT INTO preserve.lifecycle_target_intelligence (
        tenant, target_kind, target_id, source_derivation_type, horizon, lifecycle_status
      )
      SELECT tenant, 'memory', target_id, 'imported_knowledge', 'semantic', 'active'
      FROM candidates
      ON CONFLICT (tenant, target_kind, target_id) DO NOTHING
      RETURNING intelligence_id
    `;
    inserted += rows.length;
  }

  async function insertFromProcedure(): Promise<void> {
    const rows = await sql`
      WITH candidates AS (
        SELECT p.tenant, p.procedure_id AS target_id
        FROM preserve.procedure p
        WHERE p.tenant = ${tenant}
          AND NOT EXISTS (
            SELECT 1
            FROM preserve.lifecycle_target_intelligence lti
            WHERE lti.tenant = p.tenant
              AND lti.target_kind = 'procedure'
              AND lti.target_id = p.procedure_id
          )
        ORDER BY p.procedure_id
        LIMIT ${limit}
      )
      INSERT INTO preserve.lifecycle_target_intelligence (
        tenant, target_kind, target_id, source_derivation_type, horizon, lifecycle_status
      )
      SELECT tenant, 'procedure', target_id, 'imported_knowledge', 'procedural', 'active'
      FROM candidates
      ON CONFLICT (tenant, target_kind, target_id) DO NOTHING
      RETURNING intelligence_id
    `;
    inserted += rows.length;
  }

  async function insertFromEventFrame(): Promise<void> {
    const rows = await sql`
      WITH candidates AS (
        SELECT ef.tenant, ef.event_frame_id AS target_id
        FROM preserve.event_frame ef
        WHERE ef.tenant = ${tenant}
          AND NOT EXISTS (
            SELECT 1
            FROM preserve.lifecycle_target_intelligence lti
            WHERE lti.tenant = ef.tenant
              AND lti.target_kind = 'event_frame'
              AND lti.target_id = ef.event_frame_id
          )
        ORDER BY ef.event_frame_id
        LIMIT ${limit}
      )
      INSERT INTO preserve.lifecycle_target_intelligence (
        tenant, target_kind, target_id, source_derivation_type, horizon, lifecycle_status
      )
      SELECT tenant, 'event_frame', target_id, 'imported_knowledge', 'semantic', 'active'
      FROM candidates
      ON CONFLICT (tenant, target_kind, target_id) DO NOTHING
      RETURNING intelligence_id
    `;
    inserted += rows.length;
  }

  async function insertFromWorkingMemory(): Promise<void> {
    const rows = await sql`
      WITH candidates AS (
        SELECT wm.tenant, wm.working_memory_id AS target_id
        FROM preserve.working_memory wm
        WHERE wm.tenant = ${tenant}
          AND NOT EXISTS (
            SELECT 1
            FROM preserve.lifecycle_target_intelligence lti
            WHERE lti.tenant = wm.tenant
              AND lti.target_kind = 'working_memory'
              AND lti.target_id = wm.working_memory_id
          )
        ORDER BY wm.working_memory_id
        LIMIT ${limit}
      )
      INSERT INTO preserve.lifecycle_target_intelligence (
        tenant, target_kind, target_id, source_derivation_type, horizon, lifecycle_status
      )
      SELECT tenant, 'working_memory', target_id, 'imported_knowledge', 'working', 'active'
      FROM candidates
      ON CONFLICT (tenant, target_kind, target_id) DO NOTHING
      RETURNING intelligence_id
    `;
    inserted += rows.length;
  }

  if (targetKind === "all" || targetKind === "fact") await insertFromFact();
  if (targetKind === "all" || targetKind === "memory") await insertFromMemory();
  if (targetKind === "all" || targetKind === "procedure") await insertFromProcedure();
  if (targetKind === "all" || targetKind === "event_frame") await insertFromEventFrame();
  if (targetKind === "all" || targetKind === "working_memory") await insertFromWorkingMemory();
  return { inserted };
}

export async function lifecycleStats(
  sql: postgres.Sql,
  options: { tenant?: string } = {},
): Promise<Record<string, unknown>> {
  const tenant = options.tenant ?? config.tenant;
  const [outbox] = await sql`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE status = 'pending') AS pending,
      count(*) FILTER (WHERE status = 'processing') AS processing,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status = 'dead_letter') AS dead_letter,
      min(received_at) FILTER (WHERE status IN ('pending','failed')) AS oldest_ready
    FROM preserve.lifecycle_outbox
    WHERE tenant = ${tenant}
  `;
  const [intel] = await sql`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE lifecycle_status = 'review_required') AS review_required,
      count(*) FILTER (WHERE lifecycle_status = 'suppressed') AS suppressed,
      count(*) FILTER (WHERE lifecycle_status = 'retired') AS retired
    FROM preserve.lifecycle_target_intelligence
    WHERE tenant = ${tenant}
  `;
  return { tenant, outbox, intelligence: intel, configVersion: DEFAULT_CONFIG_VERSION };
}

export async function retryLifecycleEvent(
  sql: postgres.Sql,
  options: { tenant?: string; outboxId: string },
): Promise<boolean> {
  const tenant = options.tenant ?? config.tenant;
  const rows = await sql`
    UPDATE preserve.lifecycle_outbox
    SET status = 'pending',
        next_attempt_at = now(),
        claimed_at = NULL,
        claimed_by = NULL,
        error_summary = NULL
    WHERE tenant = ${tenant}
      AND outbox_id = ${options.outboxId}
      AND status IN ('failed','dead_letter')
    RETURNING outbox_id
  `;
  return rows.length > 0;
}

export async function recordContextRecallAudit(
  sql: postgres.Sql,
  input: ContextRecallAuditInput,
): Promise<{ contextAuditId: string }> {
  const tenant = input.tenant ?? config.tenant;
  const rows = await sql`
    INSERT INTO preserve.context_recall_audit (
      tenant,
      trigger,
      mode,
      injected,
      scope_path,
      session_key,
      task_id,
      trace_id,
      span_id,
      actor_type,
      actor_id,
      goal,
      cues,
      relevance_reason,
      query_plan,
      retrieved,
      prompt_package,
      omitted,
      total_tokens,
      max_tokens
    )
    VALUES (
      ${tenant},
      ${input.trigger},
      ${input.mode},
      ${input.injected ?? false},
      ${input.scopePath ?? null},
      ${input.sessionKey ?? null},
      ${input.taskId ?? null},
      ${input.traceId ?? null},
      ${input.spanId ?? null},
      ${input.actorType ?? null},
      ${input.actorId ?? null},
      ${input.goal ?? null},
      ${sql.json(toJson(input.cues ?? []))},
      ${input.relevanceReason ?? null},
      ${sql.json(toJson(input.queryPlan ?? {}))},
      ${sql.json(toJson(input.retrieved ?? []))},
      ${sql.json(toJson(input.promptPackage ?? []))},
      ${sql.json(toJson(input.omitted ?? []))},
      ${Math.max(0, Math.trunc(input.totalTokens ?? 0))},
      ${Math.max(1, Math.trunc(input.maxTokens))}
    )
    RETURNING context_audit_id
  `;
  return { contextAuditId: String(rows[0].context_audit_id) };
}
