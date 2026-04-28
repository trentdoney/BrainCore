import { createHash } from "crypto";
import type postgres from "postgres";
import { config } from "../config";

export type TaskSessionStatus = "active" | "idle" | "completed" | "failed" | "expired";
export type WorkingMemoryKind = "context" | "observation" | "plan" | "decision" | "risk" | "handoff";
export type PromotionTargetKind = "fact" | "event_frame" | "memory" | "procedure";

const DEFAULT_TTL_DAYS = 14;

export interface TaskSession {
  sessionId: string;
  tenant: string;
  sessionKey: string;
  agentName: string;
  taskTitle: string | null;
  status: TaskSessionStatus;
  scopePath: string | null;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  expiresAt: string | null;
}

export interface WorkingMemoryItem {
  workingMemoryId: string;
  tenant: string;
  sessionId: string;
  sessionKey?: string;
  memoryKind: WorkingMemoryKind;
  content: string;
  promotionStatus: string;
  promotionReason: string | null;
  promotionTargetKind: PromotionTargetKind | null;
  promotionTargetId: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface StartSessionOptions {
  tenant?: string;
  sessionKey: string;
  agentName: string;
  taskTitle?: string | null;
  scopePath?: string | null;
  ttlDays?: number;
}

export interface UpdateSessionOptions {
  tenant?: string;
  sessionKey: string;
  status?: TaskSessionStatus;
  taskTitle?: string | null;
  scopePath?: string | null;
}

export interface AddWorkingMemoryOptions {
  tenant?: string;
  sessionKey: string;
  memoryKind: WorkingMemoryKind;
  content: string;
  contentJson?: unknown;
  sourceSegmentId?: string | null;
  sourceFactId?: string | null;
  evidenceSegmentId?: string | null;
  confidence?: number | null;
  ttlDays?: number;
}

export interface PromotionCandidateOptions {
  tenant?: string;
  workingMemoryId: string;
  promotionReason: string;
  promotionTargetKind?: PromotionTargetKind | null;
  promotionTargetId?: string | null;
}

function ttlDays(value: number | undefined): number {
  if (!Number.isFinite(value ?? DEFAULT_TTL_DAYS)) return DEFAULT_TTL_DAYS;
  return Math.max(1, Math.min(Math.trunc(value ?? DEFAULT_TTL_DAYS), 365));
}

function fingerprint(parts: Array<string | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((part) => (part ?? "").trim().toLowerCase()).join("\x1f"))
    .digest("hex");
}

function rowToSession(row: any): TaskSession {
  return {
    sessionId: String(row.session_id),
    tenant: String(row.tenant),
    sessionKey: String(row.session_key),
    agentName: String(row.agent_name),
    taskTitle: row.task_title ?? null,
    status: row.status,
    scopePath: row.scope_path ?? null,
    startedAt: String(row.started_at),
    lastSeenAt: String(row.last_seen_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
  };
}

function rowToWorkingMemory(row: any): WorkingMemoryItem {
  return {
    workingMemoryId: String(row.working_memory_id),
    tenant: String(row.tenant),
    sessionId: String(row.session_id),
    sessionKey: row.session_key == null ? undefined : String(row.session_key),
    memoryKind: row.memory_kind,
    content: String(row.content),
    promotionStatus: String(row.promotion_status),
    promotionReason: row.promotion_reason ?? null,
    promotionTargetKind: row.promotion_target_kind ?? null,
    promotionTargetId: row.promotion_target_id == null ? null : String(row.promotion_target_id),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
  };
}

export async function startTaskSession(
  sql: postgres.Sql,
  options: StartSessionOptions,
): Promise<TaskSession> {
  const tenant = options.tenant ?? config.tenant;
  const rows = await sql`
    INSERT INTO preserve.task_session (
      tenant,
      session_key,
      agent_name,
      task_title,
      status,
      scope_path,
      expires_at,
      session_json
    )
    VALUES (
      ${tenant},
      ${options.sessionKey},
      ${options.agentName},
      ${options.taskTitle ?? null},
      'active',
      ${options.scopePath ?? null},
      now() + (${ttlDays(options.ttlDays)}::int * interval '1 day'),
      ${sql.json({ source: "working-memory-cli" })}
    )
    ON CONFLICT (tenant, session_key) DO UPDATE
      SET agent_name = EXCLUDED.agent_name,
          task_title = COALESCE(EXCLUDED.task_title, preserve.task_session.task_title),
          status = 'active',
          scope_path = COALESCE(EXCLUDED.scope_path, preserve.task_session.scope_path),
          last_seen_at = now(),
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
    RETURNING *
  `;
  return rowToSession(rows[0]);
}

export async function updateTaskSession(
  sql: postgres.Sql,
  options: UpdateSessionOptions,
): Promise<TaskSession | null> {
  const tenant = options.tenant ?? config.tenant;
  const rows = await sql`
    UPDATE preserve.task_session
    SET status = COALESCE(${options.status ?? null}, status),
        task_title = COALESCE(${options.taskTitle ?? null}, task_title),
        scope_path = COALESCE(${options.scopePath ?? null}, scope_path),
        last_seen_at = now(),
        updated_at = now()
    WHERE tenant = ${tenant}
      AND session_key = ${options.sessionKey}
    RETURNING *
  `;
  return rows[0] ? rowToSession(rows[0]) : null;
}

export async function closeTaskSession(
  sql: postgres.Sql,
  options: { tenant?: string; sessionKey: string; status?: "completed" | "failed" },
): Promise<TaskSession | null> {
  const tenant = options.tenant ?? config.tenant;
  const status = options.status ?? "completed";
  const rows = await sql`
    UPDATE preserve.task_session
    SET status = ${status},
        ended_at = COALESCE(ended_at, now()),
        last_seen_at = now(),
        updated_at = now()
    WHERE tenant = ${tenant}
      AND session_key = ${options.sessionKey}
    RETURNING *
  `;
  return rows[0] ? rowToSession(rows[0]) : null;
}

export async function listActiveSessions(
  sql: postgres.Sql,
  options: { tenant?: string; scope?: string | null; limit?: number } = {},
): Promise<TaskSession[]> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const rows = await sql`
    SELECT *
    FROM preserve.task_session
    WHERE tenant = ${tenant}
      AND status IN ('active', 'idle')
      AND (expires_at IS NULL OR expires_at > now())
      AND (${options.scope ?? null}::text IS NULL OR COALESCE(scope_path, '') LIKE (${options.scope ?? ""} || '%'))
    ORDER BY last_seen_at DESC
    LIMIT ${limit}
  `;
  return rows.map(rowToSession);
}

export async function addWorkingMemory(
  sql: postgres.Sql,
  options: AddWorkingMemoryOptions,
): Promise<WorkingMemoryItem | null> {
  const tenant = options.tenant ?? config.tenant;
  const rows = await sql`
    WITH session AS (
      SELECT session_id
      FROM preserve.task_session
      WHERE tenant = ${tenant}
        AND session_key = ${options.sessionKey}
        AND status IN ('active', 'idle')
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    )
    INSERT INTO preserve.working_memory (
      tenant,
      session_id,
      working_memory_fingerprint,
      memory_kind,
      content,
      content_json,
      source_segment_id,
      source_fact_id,
      evidence_segment_id,
      confidence,
      expires_at
    )
    SELECT
      ${tenant},
      session_id,
      ${fingerprint([
        tenant,
        options.sessionKey,
        options.memoryKind,
        options.content,
        options.sourceSegmentId,
        options.sourceFactId,
        options.evidenceSegmentId,
      ])},
      ${options.memoryKind},
      ${options.content},
      ${sql.json((options.contentJson ?? {}) as any)},
      ${options.sourceSegmentId ?? null},
      ${options.sourceFactId ?? null},
      ${options.evidenceSegmentId ?? null},
      ${options.confidence ?? null},
      now() + (${ttlDays(options.ttlDays)}::int * interval '1 day')
    FROM session
    ON CONFLICT (tenant, working_memory_fingerprint) DO UPDATE
      SET content = EXCLUDED.content,
          content_json = EXCLUDED.content_json,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
    RETURNING *
  `;
  return rows[0] ? rowToWorkingMemory(rows[0]) : null;
}

export async function markPromotionCandidate(
  sql: postgres.Sql,
  options: PromotionCandidateOptions,
): Promise<WorkingMemoryItem | null> {
  const tenant = options.tenant ?? config.tenant;
  const rows = await sql`
    UPDATE preserve.working_memory wm
    SET promotion_status = 'promotion_candidate',
        promotion_reason = ${options.promotionReason},
        promotion_target_kind = ${options.promotionTargetKind ?? null},
        promotion_target_id = ${options.promotionTargetId ?? null},
        promotion_marked_at = now(),
        updated_at = now()
    FROM preserve.task_session ts
    WHERE wm.tenant = ${tenant}
      AND wm.working_memory_id = ${options.workingMemoryId}
      AND ts.tenant = wm.tenant
      AND ts.session_id = wm.session_id
      AND ts.status IN ('completed', 'failed')
      AND wm.expires_at > now()
      AND (
        wm.evidence_segment_id IS NOT NULL
        OR wm.source_segment_id IS NOT NULL
        OR wm.source_fact_id IS NOT NULL
      )
    RETURNING wm.*, ts.session_key
  `;
  return rows[0] ? rowToWorkingMemory(rows[0]) : null;
}

export async function listWorkingMemory(
  sql: postgres.Sql,
  options: {
    tenant?: string;
    sessionKey?: string | null;
    includeExpired?: boolean;
    promotionStatus?: string | null;
    limit?: number;
  } = {},
): Promise<WorkingMemoryItem[]> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const rows = await sql`
    SELECT wm.*, ts.session_key
    FROM preserve.working_memory wm
    JOIN preserve.task_session ts
      ON ts.tenant = wm.tenant
     AND ts.session_id = wm.session_id
    WHERE wm.tenant = ${tenant}
      AND (${options.sessionKey ?? null}::text IS NULL OR ts.session_key = ${options.sessionKey ?? ""})
      AND (${options.includeExpired ?? false}::boolean OR wm.expires_at > now())
      AND (${options.promotionStatus ?? null}::text IS NULL OR wm.promotion_status = ${options.promotionStatus ?? ""})
    ORDER BY wm.created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(rowToWorkingMemory);
}

export async function cleanupExpiredWorkingMemory(
  sql: postgres.Sql,
  options: { tenant?: string; limit?: number } = {},
): Promise<{ expired: number }> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
  const rows = await sql`
    WITH expired AS (
      SELECT working_memory_id
      FROM preserve.working_memory
      WHERE tenant = ${tenant}
        AND expires_at <= now()
        AND promotion_status IN ('not_promoted', 'promotion_candidate', 'rejected')
      ORDER BY expires_at ASC
      LIMIT ${limit}
    )
    UPDATE preserve.working_memory wm
    SET promotion_status = 'expired',
        updated_at = now()
    FROM expired
    WHERE wm.working_memory_id = expired.working_memory_id
    RETURNING wm.working_memory_id
  `;
  return { expired: rows.length };
}
