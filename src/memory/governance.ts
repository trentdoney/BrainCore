import { createHash } from "crypto";
import { config } from "../config";
import type postgres from "postgres";

export type MemoryNamespace = "working" | "episodic" | "semantic" | "procedural" | "policy";
export type MemoryGovernanceStatus =
  | "candidate"
  | "archived"
  | "active"
  | "review_required"
  | "validated"
  | "disputed"
  | "quarantined"
  | "suppressed"
  | "retired";
export type MemorySourceClass =
  | "observed"
  | "user_stated"
  | "system_inferred"
  | "summary_derived"
  | "replay_derived"
  | "imported_knowledge"
  | "corrected_by_user";
export type MemoryTrustClass =
  | "deterministic"
  | "human_curated"
  | "corroborated_llm"
  | "single_source_llm"
  | "retired_superseded";
export type MemorySensitivityClass = "public" | "internal" | "confidential" | "restricted";
export type MemoryRedactionStatus = "raw" | "redacted" | "sanitized" | "not_required";

export interface MemoryLifecycleEvent {
  eventId: string;
  eventType: string;
  sourceService: string;
  idempotencyKey?: string;
  tenant?: string;
  projectEntityId?: string;
  episodeId?: string;
  traceId?: string;
  spanId?: string;
  actorType?: string;
  actorId?: string;
  occurredAt?: string | Date;
  sensitivityClass?: MemorySensitivityClass;
  redactionStatus?: MemoryRedactionStatus;
  payload?: Record<string, unknown>;
  evidenceRefs?: Record<string, unknown>[];
  schemaVersion?: number;
  configVersion?: string;
}

export interface MemoryFeedbackEvent {
  memoryId: string;
  signal: string;
  tenant?: string;
  outcome?: string;
  details?: Record<string, unknown>;
  actorType?: string;
  actorId?: string;
}

export interface PromptReadAudit {
  query?: string;
  trigger?: string;
  retrievedMemoryIds: string[];
  injectedMemoryIds?: string[];
  omitted?: Array<{ memoryId: string; reason: string }>;
  promptPackage?: unknown[];
  totalTokens: number;
  maxTokens?: number;
  relevanceReason?: string;
  actor?: string;
  route?: string;
  requestId?: string;
  tenant?: string;
}

export interface GovernedMemoryDraft {
  fingerprint: string;
  title: string;
  narrative: string;
  namespace: MemoryNamespace;
  status: MemoryGovernanceStatus;
  sourceClass: MemorySourceClass;
  trustClass: MemoryTrustClass;
  qualityScore: number;
  salience: number;
  strength: number;
  stability: number;
  tokenCount: number;
  cues: MemoryCue[];
}

export interface MemoryCue {
  cueText: string;
  cueHash: string;
  cueType: string;
  extractionMethod: "template" | "keyword";
  confidence: number;
  evidenceRef?: string;
  usefulnessScore: number;
}

export type ContextInjectionMode = "off" | "shadow" | "eval" | "default_on";
export type PromptMemoryRole = "fact" | "warning" | "guidance" | "context" | "uncertainty";

export interface ContextRecallRequest {
  trigger: string;
  tenant?: string;
  scope?: string;
  cues?: string[];
  goal?: string;
  actionType?: string;
  maxTokens?: number;
  injectionMode?: ContextInjectionMode;
  relevanceReason?: string;
  actor?: string;
  route?: string;
  requestId?: string;
  limit?: number;
  includeExcluded?: boolean;
}

export interface MemoryPromptResult {
  memoryId: string;
  memoryType?: string;
  title?: string;
  content: string;
  confidence?: number;
  namespace?: MemoryNamespace;
  governanceStatus?: MemoryGovernanceStatus;
  sourceClass?: MemorySourceClass;
  trustClass?: MemoryTrustClass;
  qualityScore?: number;
  strength?: number;
  priority?: number;
  scopePath?: string;
  tokenCount: number;
  score: number;
  relevanceReason?: string;
  truncated?: boolean;
}

export interface PromptPackageItem {
  section: string;
  memoryId: string;
  role: PromptMemoryRole;
  reason: string;
  content: string;
  qualityScore?: number;
  tokenCount: number;
  governanceStatus?: MemoryGovernanceStatus;
}

export interface ContextRecallResult {
  trigger: string;
  mode: ContextInjectionMode;
  injected: boolean;
  results: MemoryPromptResult[];
  promptPackage: PromptPackageItem[];
  omitted: Array<{ memoryId: string; reason: string }>;
  totalTokens: number;
}

export interface QualityAuditInput {
  memoryId: string;
  tenant?: string;
  triggerType: string;
  previousQualityScore?: number | null;
  newQualityScore: number;
  qualityFactors?: Record<string, unknown>;
  formulaVersion?: string;
  configVersion?: string;
}

export interface MemoryCompactionOptions {
  tenant?: string;
  staleBefore?: Date;
  minQuality?: number;
  pruneCompletedBefore?: Date;
}

export interface MemoryCompactionResult {
  archived: number;
  prunedOutbox: number;
}

export interface MemoryConflictDetectionOptions {
  tenant?: string;
  limit?: number;
}

export interface MemoryConflictDetectionResult {
  conflicts: number;
  edgeIds: string[];
}

export interface MemorySourceAttribution {
  memoryId: string;
  tenant: string;
  sourceService?: string;
  eventId?: string;
  episodeId?: string;
  projectEntityId?: string;
  traceId?: string;
  spanId?: string;
  evidenceRefs: unknown[];
  scopePath?: string;
  createdAt?: string;
  updatedAt?: string;
}

const NON_PROMPT_STATUSES = new Set<MemoryGovernanceStatus>(["archived", "quarantined", "suppressed", "retired"]);
const MEMORY_SENSITIVITY_CLASSES: MemorySensitivityClass[] = ["public", "internal", "confidential", "restricted"];
const MEMORY_REDACTION_STATUSES: MemoryRedactionStatus[] = ["raw", "redacted", "sanitized", "not_required"];
const CONFIG_VERSION = "braincore-memory-governance-v1";
const LIFECYCLE_OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function requireGovernanceChoice<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalGovernanceChoice<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  return value === undefined ? undefined : requireGovernanceChoice(value, allowed, label);
}

export function isPromptEligible(status?: string | null): boolean {
  return !NON_PROMPT_STATUSES.has((status ?? "active") as MemoryGovernanceStatus);
}

export function estimateTokenCount(content: string): number {
  if (!content.trim()) return 0;
  const words = content.trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(Math.max(content.length / 4, words * 1.3)));
}

export function applyTokenBudget(content: string, maxTokens?: number): { content: string; tokenCount: number; truncated: boolean } {
  const tokenCount = estimateTokenCount(content);
  if (!maxTokens || maxTokens <= 0 || tokenCount <= maxTokens) {
    return { content, tokenCount, truncated: false };
  }
  const truncated = content.slice(0, Math.max(1, maxTokens * 4)).trimEnd();
  return { content: truncated, tokenCount: estimateTokenCount(truncated), truncated: true };
}

export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=:-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\bfake-secret(?:-[A-Za-z0-9_-]+)?\b/gi, "[REDACTED_SECRET]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b((?:[a-z][a-z0-9_-]*[_-]?)?(?:api[_-]?key|token|secret|password))\s*[:=]\s*["']?[^"'\s,;}]{8,}/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED_TOKEN]");
}

export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactValue(item)]),
    ) as T;
  }
  return value;
}

export function draftFromLifecycleEvent(event: MemoryLifecycleEvent): GovernedMemoryDraft {
  const cues = extractLifecycleCues(event);
  const qualityScore = scoreQuality(event, cues);
  const salience = scoreSalience(event);
  const sourceClass = sourceClassForEvent(event.eventType);
  const status: MemoryGovernanceStatus =
    sourceClass === "corrected_by_user" || sourceClass === "user_stated"
      ? "validated"
      : qualityScore < 0.45
        ? "review_required"
        : "active";
  const narrative = summarizeLifecycleEvent(event);
  return {
    fingerprint: sha256(`${event.tenant ?? config.tenant}|lifecycle|${event.eventId}`),
    title: `${event.eventType} from ${event.sourceService}`,
    narrative,
    namespace: namespaceForEvent(event.eventType),
    status,
    sourceClass,
    trustClass: trustClassForSource(sourceClass),
    qualityScore,
    salience,
    strength: clamp01(0.15 + 0.65 * salience + 0.2 * qualityScore),
    stability: clamp01(0.08 + 0.12 * sourceReliability(event) + (event.eventType === "user_corrected" ? 0.15 : 0)),
    tokenCount: estimateTokenCount(narrative),
    cues,
  };
}

export async function recordLifecycleEvent(sql: postgres.Sql, event: MemoryLifecycleEvent): Promise<void> {
  const tenant = event.tenant ?? config.tenant;
  const idempotencyKey = event.idempotencyKey ?? `${event.sourceService}:${event.eventId}`;
  const sensitivityClass = optionalGovernanceChoice(event.sensitivityClass, MEMORY_SENSITIVITY_CLASSES, "sensitivityClass");
  const redactionStatus = requireGovernanceChoice(event.redactionStatus ?? "redacted", MEMORY_REDACTION_STATUSES, "redactionStatus");
  await sql`
    INSERT INTO preserve.memory_lifecycle_outbox (
      event_id, idempotency_key, event_type, source_service, tenant, project_entity_id,
      episode_id, trace_id, span_id, actor_type, actor_id, occurred_at, sensitivity_class,
      redaction_status, payload, evidence_refs, schema_version, config_version
    ) VALUES (
      ${event.eventId}, ${idempotencyKey}, ${event.eventType}, ${event.sourceService}, ${tenant},
      ${event.projectEntityId ?? null}, ${event.episodeId ?? null}, ${event.traceId ?? null}, ${event.spanId ?? null},
      ${event.actorType ?? null}, ${event.actorId ?? null}, ${event.occurredAt ? new Date(event.occurredAt) : new Date()},
      ${sensitivityClass ?? null}, ${redactionStatus},
      ${sql.json(redactValue(event.payload ?? {}) as any)}, ${sql.json(redactValue(event.evidenceRefs ?? []) as any)},
      ${event.schemaVersion ?? 1}, ${event.configVersion ?? CONFIG_VERSION}
    )
    ON CONFLICT (tenant, idempotency_key) DO NOTHING
  `;
}

export async function recordLifecycleEvents(sql: postgres.Sql, events: MemoryLifecycleEvent[]): Promise<{ accepted: number }> {
  for (const event of events) {
    await recordLifecycleEvent(sql, event);
  }
  return { accepted: events.length };
}

export async function pruneLifecycleOutbox(
  sql: postgres.Sql,
  completedBefore = new Date(Date.now() - LIFECYCLE_OUTBOX_RETENTION_MS),
  tenant = config.tenant,
): Promise<number> {
  const rows = await sql`
    DELETE FROM preserve.memory_lifecycle_outbox
    WHERE tenant = ${tenant}
      AND status IN ('completed'::preserve.memory_outbox_status, 'dead_letter'::preserve.memory_outbox_status)
      AND COALESCE(completed_at, received_at) < ${completedBefore}
    RETURNING outbox_id
  `;
  return rows.length;
}

export async function processLifecycleEvents(sql: postgres.Sql, limit = 10, tenant = config.tenant): Promise<{ processed: number; memoryIds: string[] }> {
  const memoryIds: string[] = [];
  let processed = 0;
  await sql.begin(async (tx) => {
    const events = await tx`
      WITH claimed AS (
        SELECT outbox_id
        FROM preserve.memory_lifecycle_outbox
        WHERE tenant = ${tenant}
          AND status IN ('pending'::preserve.memory_outbox_status, 'failed'::preserve.memory_outbox_status)
          AND next_attempt_at <= now()
          AND attempt_count < max_attempts
        ORDER BY received_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE preserve.memory_lifecycle_outbox o
      SET status = 'processing'::preserve.memory_outbox_status,
          claimed_at = now(),
          attempt_count = attempt_count + 1
      FROM claimed
      WHERE o.outbox_id = claimed.outbox_id
      RETURNING o.*
    `;

    for (const row of events) {
      processed++;
      try {
        const event = lifecycleRowToEvent(row);
        const memoryId = await insertMemoryFromLifecycleEvent(tx, event);
        memoryIds.push(memoryId);
        await tx`
          UPDATE preserve.memory_lifecycle_outbox
          SET status = 'completed'::preserve.memory_outbox_status,
              completed_at = now(),
              memory_id = ${memoryId}
          WHERE outbox_id = ${row.outbox_id}
        `;
      } catch (err: any) {
        await tx`
          UPDATE preserve.memory_lifecycle_outbox
          SET status = CASE WHEN attempt_count >= max_attempts
                            THEN 'dead_letter'::preserve.memory_outbox_status
                            ELSE 'failed'::preserve.memory_outbox_status END,
              error_summary = ${sanitizeErrorSummary(err)},
              next_attempt_at = now() + (interval '1 second' * LEAST(300, POWER(2, attempt_count)))
          WHERE outbox_id = ${row.outbox_id}
        `;
      }
    }
  });
  await pruneLifecycleOutbox(sql, new Date(Date.now() - LIFECYCLE_OUTBOX_RETENTION_MS), tenant);
  return { processed, memoryIds };
}

export async function setMemoryGovernanceStatus(
  sql: postgres.Sql,
  memoryId: string,
  status: MemoryGovernanceStatus,
  details: { reason?: string; actorType?: string; actorId?: string; tenant?: string } = {},
): Promise<void> {
  const tenant = details.tenant ?? config.tenant;
  await sql.begin(async (tx) => {
    const [updated] = await tx`
      WITH existing AS (
        SELECT memory_id, COALESCE(quality_score, confidence, 0.5)::float AS previous_quality_score
        FROM preserve.memory
        WHERE memory_id = ${memoryId}
          AND tenant = ${tenant}
      ), updated AS (
        UPDATE preserve.memory m
        SET governance_status = ${status}::preserve.memory_governance_status,
            quality_score = CASE
              WHEN ${status} = 'validated' THEN LEAST(1, COALESCE(m.quality_score, m.confidence, 0.5) + 0.05)
              WHEN ${status} IN ('archived','quarantined','suppressed','retired') THEN GREATEST(0, COALESCE(m.quality_score, m.confidence, 0.5) - 0.15)
              ELSE m.quality_score
            END,
            governance_meta = COALESCE(m.governance_meta, '{}'::jsonb) || ${tx.json(redactValue({
              last_status_change: { status, reason: details.reason, actorType: details.actorType, actorId: details.actorId, changedAt: new Date().toISOString() },
            }) as any)}::jsonb,
            updated_at = now()
        FROM existing e
        WHERE m.memory_id = e.memory_id
        RETURNING m.memory_id::text, e.previous_quality_score, COALESCE(m.quality_score, m.confidence, 0.5)::float AS new_quality_score
      )
      SELECT * FROM updated
    `;
    if (updated) {
      await recordQualityAudit(tx, {
        memoryId: updated.memory_id,
        tenant,
        triggerType: 'admin_status_change',
        previousQualityScore: updated.previous_quality_score,
        newQualityScore: updated.new_quality_score,
        qualityFactors: { status, reason: details.reason, actorType: details.actorType ?? 'operator' },
      });
    }
  });
}

export async function recordMemoryFeedback(sql: postgres.Sql, feedback: MemoryFeedbackEvent): Promise<boolean> {
  const tenant = feedback.tenant ?? config.tenant;
  const delta = feedbackDelta(feedback.signal);
  let recorded = false;
  await sql.begin(async (tx) => {
    const [updated] = await tx`
      WITH target AS (
        SELECT memory_id, COALESCE(quality_score, confidence, 0.5)::float AS previous_quality_score
        FROM preserve.memory
        WHERE memory_id = ${feedback.memoryId}
          AND tenant = ${tenant}
        FOR UPDATE
      ), feedback_row AS (
        INSERT INTO preserve.memory_feedback_event (memory_id, tenant, signal, outcome, details, actor_type, actor_id)
        SELECT target.memory_id, ${tenant}, ${feedback.signal}, ${feedback.outcome ? redactText(feedback.outcome) : null},
               ${tx.json(redactValue(feedback.details ?? {}) as any)}, ${feedback.actorType ?? null}, ${feedback.actorId ?? null}
        FROM target
        RETURNING feedback_id
      ), updated AS (
        UPDATE preserve.memory m
        SET quality_score = GREATEST(0, LEAST(1, COALESCE(m.quality_score, m.confidence, 0.5) + ${delta.quality})),
            strength = GREATEST(0, LEAST(1, COALESCE(m.strength, 0.5) + ${delta.strength})),
            stability = GREATEST(0, LEAST(1, COALESCE(m.stability, 0.1) + ${delta.stability})),
            support_count = m.support_count + ${delta.strength > 0 ? 1 : 0},
            contradiction_count = m.contradiction_count + ${feedback.signal === "injected_contradicted" ? 1 : 0},
            last_reinforced_at = CASE WHEN ${delta.strength} > 0 THEN now() ELSE m.last_reinforced_at END,
            updated_at = now()
        FROM target e, feedback_row f
        WHERE m.memory_id = e.memory_id
          AND m.tenant = ${tenant}
        RETURNING m.memory_id::text, e.previous_quality_score, COALESCE(m.quality_score, m.confidence, 0.5)::float AS new_quality_score
      )
      SELECT * FROM updated
    `;
    if (updated) {
      await recordQualityAudit(tx, {
        memoryId: updated.memory_id,
        tenant,
        triggerType: 'feedback',
        previousQualityScore: updated.previous_quality_score,
        newQualityScore: updated.new_quality_score,
        qualityFactors: { signal: feedback.signal, strengthDelta: delta.strength, stabilityDelta: delta.stability, qualityDelta: delta.quality },
      });
      recorded = true;
    }
  });
  return recorded;
}

export async function auditPromptRead(sql: postgres.Sql, audit: PromptReadAudit): Promise<void> {
  const tenant = audit.tenant ?? config.tenant;
  const retrievedMemoryIds = await tenantScopedMemoryIds(sql, tenant, audit.retrievedMemoryIds);
  const injectedMemoryIds = await tenantScopedMemoryIds(sql, tenant, audit.injectedMemoryIds ?? []);
  const scopedMemoryIds = new Set([...retrievedMemoryIds, ...injectedMemoryIds]);
  await sql`
    INSERT INTO preserve.memory_context_audit (
      tenant, query, trigger, retrieved_memory_ids, injected_memory_ids, omitted,
      prompt_package, total_tokens, max_tokens, relevance_reason, actor, route, request_id
    ) VALUES (
      ${tenant}, ${audit.query ? redactText(audit.query) : null}, ${audit.trigger ? redactText(audit.trigger) : null},
      ${retrievedMemoryIds}, ${injectedMemoryIds},
      ${sql.json(filteredOmissions(audit.omitted ?? [], scopedMemoryIds) as any)},
      ${sql.json(filteredPromptPackage(audit.promptPackage ?? [], scopedMemoryIds) as any)},
      ${audit.totalTokens}, ${audit.maxTokens ?? null}, ${audit.relevanceReason ? redactText(audit.relevanceReason) : null},
      ${audit.actor ? redactText(audit.actor) : null}, ${audit.route ? redactText(audit.route) : null}, ${audit.requestId ? redactText(audit.requestId) : null}
    )
  `;
}

export async function recordQualityAudit(sql: any, audit: QualityAuditInput): Promise<boolean> {
  const tenant = audit.tenant ?? config.tenant;
  const rows = await sql`
    INSERT INTO preserve.memory_quality_audit (
      memory_id, tenant, trigger_type, previous_quality_score, new_quality_score,
      quality_factors, formula_version, config_version
    )
    SELECT
      m.memory_id, ${tenant}, ${audit.triggerType}, ${audit.previousQualityScore ?? null}, ${audit.newQualityScore},
      ${sql.json(redactValue(audit.qualityFactors ?? {}) as any)}, ${audit.formulaVersion ?? CONFIG_VERSION}, ${audit.configVersion ?? CONFIG_VERSION}
    FROM preserve.memory m
    WHERE m.memory_id = ${audit.memoryId}
      AND m.tenant = ${tenant}
    RETURNING quality_audit_id
  `;
  return rows.length > 0;
}

export async function searchForPrompt(sql: postgres.Sql, request: ContextRecallRequest): Promise<MemoryPromptResult[]> {
  const tenant = request.tenant ?? config.tenant;
  const queryText = contextQueryText(request);
  const scopePattern = request.scope ? `${request.scope}%` : null;
  const limit = Math.max(1, Math.min(100, request.limit ?? 20));
  const includeExcluded = request.includeExcluded ?? false;
  const likeQuery = `%${queryText}%`;
  const rows = queryText
    ? await sql`
      SELECT
        m.memory_id::text,
        m.memory_type::text,
        m.title,
        m.narrative,
        m.confidence::float,
        m.scope_path,
        m.priority,
        m.namespace::text,
        m.governance_status::text,
        m.source_class::text,
        m.trust_class::text,
        m.quality_score::float,
        m.strength::float,
        m.token_count,
        ts_rank_cd(m.fts, plainto_tsquery('english', ${queryText}))::float AS text_rank
      FROM preserve.memory m
      WHERE m.tenant = ${tenant}
        AND (${scopePattern}::text IS NULL OR m.scope_path LIKE ${scopePattern})
        AND (${includeExcluded}::boolean OR m.governance_status NOT IN ('archived','quarantined','suppressed','retired'))
        AND (m.fts @@ plainto_tsquery('english', ${queryText}) OR m.title ILIKE ${likeQuery} OR m.narrative ILIKE ${likeQuery})
        AND (${includeExcluded}::boolean OR COALESCE(m.trust_class, 'deterministic'::preserve.memory_trust_class) <> 'retired_superseded'::preserve.memory_trust_class)
      ORDER BY text_rank DESC, COALESCE(m.quality_score, m.confidence, 0.5) DESC, m.priority ASC, m.updated_at DESC
      LIMIT ${limit}
    `
    : await sql`
      SELECT
        m.memory_id::text,
        m.memory_type::text,
        m.title,
        m.narrative,
        m.confidence::float,
        m.scope_path,
        m.priority,
        m.namespace::text,
        m.governance_status::text,
        m.source_class::text,
        m.trust_class::text,
        m.quality_score::float,
        m.strength::float,
        m.token_count,
        0::float AS text_rank
      FROM preserve.memory m
      WHERE m.tenant = ${tenant}
        AND (${scopePattern}::text IS NULL OR m.scope_path LIKE ${scopePattern})
        AND (${includeExcluded}::boolean OR m.governance_status NOT IN ('archived','quarantined','suppressed','retired'))
        AND (${includeExcluded}::boolean OR COALESCE(m.trust_class, 'deterministic'::preserve.memory_trust_class) <> 'retired_superseded'::preserve.memory_trust_class)
      ORDER BY COALESCE(m.quality_score, m.confidence, 0.5) DESC, m.priority ASC, m.updated_at DESC
      LIMIT ${limit}
    `;
  return rows.map((row: any) => rowToPromptResult(row, request.relevanceReason ?? `context:${request.trigger}`));
}

export async function readForPrompt(
  sql: postgres.Sql,
  memoryId: string,
  options: { tenant?: string; maxTokens?: number; relevanceReason?: string; actor?: string; route?: string; requestId?: string } = {},
): Promise<MemoryPromptResult | null> {
  const tenant = options.tenant ?? config.tenant;
  const [row] = await sql`
    SELECT
      m.memory_id::text,
      m.memory_type::text,
      m.title,
      m.narrative,
      m.confidence::float,
      m.scope_path,
      m.priority,
      m.namespace::text,
      m.governance_status::text,
      m.source_class::text,
      m.quality_score::float,
      m.trust_class::text,
      m.strength::float,
      m.token_count,
      1::float AS text_rank
    FROM preserve.memory m
    WHERE m.memory_id = ${memoryId}
      AND m.tenant = ${tenant}
    LIMIT 1
  `;
  if (!row) return null;
  const result = rowToPromptResult(row, options.relevanceReason ?? 'direct_prompt_read');
  if (!isRecallEligible(result)) {
    await auditPromptRead(sql, {
      tenant,
      trigger: 'direct_read',
      retrievedMemoryIds: [result.memoryId],
      injectedMemoryIds: [],
      omitted: [{ memoryId: result.memoryId, reason: omitReason(result) }],
      totalTokens: 0,
      maxTokens: options.maxTokens,
      relevanceReason: options.relevanceReason,
      actor: options.actor,
      route: options.route ?? 'readForPrompt',
      requestId: options.requestId,
    });
    return null;
  }
  const [budgeted] = applyResultBudget([result], options.maxTokens ?? result.tokenCount, options.relevanceReason);
  if (!budgeted) return null;
  await auditPromptRead(sql, {
    tenant,
    trigger: 'direct_read',
    retrievedMemoryIds: [result.memoryId],
    injectedMemoryIds: [budgeted.memoryId],
    promptPackage: packageMemoriesForPrompt([budgeted], 'default_on', options.maxTokens ?? budgeted.tokenCount),
    totalTokens: budgeted.tokenCount,
    maxTokens: options.maxTokens,
    relevanceReason: options.relevanceReason,
    actor: options.actor,
    route: options.route ?? 'readForPrompt',
    requestId: options.requestId,
  });
  return budgeted;
}

export async function recallForContext(sql: postgres.Sql, request: ContextRecallRequest): Promise<ContextRecallResult> {
  const tenant = request.tenant ?? config.tenant;
  const mode = request.injectionMode ?? 'shadow';
  const maxTokens = request.maxTokens ?? 800;
  const query = contextQueryText(request);
  const candidateResults = await searchForPrompt(sql, { ...request, tenant, includeExcluded: true, limit: request.limit ?? 20 });
  const budgetedResults = applyResultBudget(candidateResults.filter(isRecallEligible), maxTokens, request.relevanceReason ?? `context:${request.trigger}`);
  const promptPackage = packageMemoriesForPrompt(budgetedResults, mode, maxTokens);
  const packageIds = new Set(promptPackage.map((item) => item.memoryId));
  const omitted = candidateResults
    .filter((result) => !packageIds.has(result.memoryId))
    .map((result) => ({ memoryId: result.memoryId, reason: omitReason(result, packageIds, mode) }));
  const totalTokens = promptPackage.reduce((sum, item) => sum + item.tokenCount, 0);
  const injected = mode === 'eval' || mode === 'default_on';

  await auditPromptRead(sql, {
    tenant,
    query,
    trigger: request.trigger,
    retrievedMemoryIds: candidateResults.map((result) => result.memoryId),
    injectedMemoryIds: injected ? promptPackage.map((item) => item.memoryId) : [],
    omitted,
    promptPackage,
    totalTokens,
    maxTokens,
    relevanceReason: request.relevanceReason ?? `context:${request.trigger}`,
    actor: request.actor ?? 'context-engine',
    route: request.route ?? 'recallForContext',
    requestId: request.requestId,
  });

  return { trigger: request.trigger, mode, injected, results: budgetedResults, promptPackage, omitted, totalTokens };
}

export async function compactMemoryGovernance(sql: postgres.Sql, options: MemoryCompactionOptions = {}): Promise<MemoryCompactionResult> {
  const tenant = options.tenant ?? config.tenant;
  const staleBefore = options.staleBefore ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const minQuality = options.minQuality ?? 0.3;
  const rows = await sql.begin(async (tx) => {
    const updatedRows = await tx`
      WITH existing AS (
        SELECT memory_id, COALESCE(quality_score, confidence, 0.5)::float AS previous_quality_score
        FROM preserve.memory
        WHERE tenant = ${tenant}
          AND governance_status IN ('candidate','review_required','active')
          AND COALESCE(quality_score, confidence, 0) < ${minQuality}
          AND COALESCE(last_supported_at, updated_at, created_at) < ${staleBefore}
      ), updated AS (
        UPDATE preserve.memory m
        SET governance_status = 'archived'::preserve.memory_governance_status,
            governance_meta = COALESCE(m.governance_meta, '{}'::jsonb) || ${tx.json(redactValue({ compactedAt: new Date().toISOString(), reason: 'stale_low_quality' }) as any)}::jsonb,
            updated_at = now()
        FROM existing e
        WHERE m.memory_id = e.memory_id
        RETURNING m.memory_id::text, e.previous_quality_score, COALESCE(m.quality_score, m.confidence, 0.5)::float AS new_quality_score
      )
      SELECT * FROM updated
    `;
    for (const row of updatedRows) {
      await recordQualityAudit(tx, {
        memoryId: row.memory_id,
        tenant,
        triggerType: 'compact_archive',
        previousQualityScore: row.previous_quality_score,
        newQualityScore: row.new_quality_score,
        qualityFactors: { staleBefore: staleBefore.toISOString(), minQuality, status: 'archived' },
      });
    }
    return updatedRows;
  });
  const prunedOutbox = await pruneLifecycleOutbox(sql, options.pruneCompletedBefore, tenant);
  return { archived: rows.length, prunedOutbox };
}

export async function detectMemoryConflicts(sql: postgres.Sql, options: MemoryConflictDetectionOptions = {}): Promise<MemoryConflictDetectionResult> {
  const tenant = options.tenant ?? config.tenant;
  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  const rows = await sql`
    SELECT
      a.memory_id::text AS from_memory_id,
      b.memory_id::text AS to_memory_id,
      a.title AS from_title,
      b.title AS to_title,
      a.scope_path AS scope_path,
      count(cb.cue_hash)::int AS shared_cues
    FROM preserve.memory a
    JOIN preserve.memory b
      ON a.tenant = b.tenant
     AND a.memory_id < b.memory_id
     AND COALESCE(a.scope_path, '') = COALESCE(b.scope_path, '')
     AND COALESCE(a.narrative, '') <> COALESCE(b.narrative, '')
    LEFT JOIN preserve.memory_cue ca ON ca.memory_id = a.memory_id
    LEFT JOIN preserve.memory_cue cb ON cb.memory_id = b.memory_id AND cb.cue_hash = ca.cue_hash
    WHERE a.tenant = ${tenant}
      AND a.governance_status NOT IN ('archived','quarantined','suppressed','retired')
      AND b.governance_status NOT IN ('archived','quarantined','suppressed','retired')
      AND (
        lower(COALESCE(a.title, '')) = lower(COALESCE(b.title, ''))
        OR cb.cue_hash IS NOT NULL
        OR (COALESCE(b.title, '') <> '' AND a.fts @@ plainto_tsquery('english', b.title))
        OR (COALESCE(a.title, '') <> '' AND b.fts @@ plainto_tsquery('english', a.title))
      )
    GROUP BY a.memory_id, b.memory_id, a.title, b.title, a.scope_path
    ORDER BY shared_cues DESC, a.memory_id, b.memory_id
    LIMIT ${limit}
  `;
  const edgeIds: string[] = [];
  for (const row of rows) {
    const edgeFingerprint = sha256(`${tenant}|memory|${row.from_memory_id}|contradicts|memory|${row.to_memory_id}`);
    const [edge] = await sql`
      INSERT INTO preserve.memory_edge (
        tenant, source_type, source_id, target_type, target_id,
        edge_type, edge_fingerprint, confidence, assertion_class, scope_path
      ) VALUES (
        ${tenant}, 'memory', ${row.from_memory_id}, 'memory', ${row.to_memory_id},
        'contradicts', ${edgeFingerprint}, 0.6, 'deterministic'::preserve.assertion_class, ${row.scope_path ?? null}
      )
      ON CONFLICT (tenant, edge_fingerprint) DO UPDATE SET
        confidence = GREATEST(preserve.memory_edge.confidence, EXCLUDED.confidence),
        updated_at = now()
      RETURNING edge_id::text
    `;
    if (edge?.edge_id) edgeIds.push(edge.edge_id);
  }
  if (rows.length > 0) {
    const memoryIds = [...new Set(rows.flatMap((row: any) => [row.from_memory_id, row.to_memory_id]))];
    await sql`
      UPDATE preserve.memory m
      SET contradiction_count = contradiction_count + 1,
          updated_at = now()
      WHERE m.memory_id = ANY(${memoryIds}::uuid[])
        AND m.tenant = ${tenant}
    `;
  }
  return { conflicts: rows.length, edgeIds };
}

export async function getMemorySourceAttribution(sql: postgres.Sql, memoryId: string, tenant = config.tenant): Promise<MemorySourceAttribution | null> {
  const [row] = await sql`
    SELECT
      memory_id::text,
      tenant,
      scope_path,
      governance_meta,
      created_at,
      updated_at
    FROM preserve.memory
    WHERE memory_id = ${memoryId}
      AND tenant = ${tenant}
    LIMIT 1
  `;
  if (!row) return null;
  const lifecycleEvent = row.governance_meta?.lifecycleEvent ?? row.governance_meta?.lifecycle_event ?? {};
  return {
    memoryId: row.memory_id,
    tenant: row.tenant,
    sourceService: lifecycleEvent.sourceService,
    eventId: lifecycleEvent.eventId,
    episodeId: lifecycleEvent.episodeId,
    projectEntityId: lifecycleEvent.projectEntityId,
    traceId: lifecycleEvent.traceId,
    spanId: lifecycleEvent.spanId,
    evidenceRefs: Array.isArray(lifecycleEvent.evidenceRefs) ? lifecycleEvent.evidenceRefs : [],
    scopePath: row.scope_path ?? undefined,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  };
}

async function insertMemoryFromLifecycleEvent(sql: postgres.TransactionSql, event: MemoryLifecycleEvent): Promise<string> {
  const tenant = event.tenant ?? config.tenant;
  const draft = draftFromLifecycleEvent(event);
  const [existing] = await sql`
    SELECT memory_id::text, COALESCE(quality_score, confidence, 0.5)::float AS previous_quality_score
    FROM preserve.memory
    WHERE tenant = ${tenant}
      AND fingerprint = ${draft.fingerprint}
    LIMIT 1
  `;
  const [memory] = await sql`
    INSERT INTO preserve.memory (
      memory_type, fingerprint, title, narrative, support_count, contradiction_count, confidence,
      lifecycle_state, pipeline_version, model_name, prompt_version, scope_path, last_supported_at,
      tenant, namespace, governance_status, source_class, salience, strength, stability, quality_score,
      token_count, schema_version, config_version, governance_meta, trust_class
    ) VALUES (
      'heuristic'::preserve.memory_type, ${draft.fingerprint}, ${draft.title}, ${draft.narrative},
      ${draft.sourceClass === "observed" ? 1 : 0}, 0, ${draft.qualityScore},
      'draft'::preserve.lifecycle_state, 'memory-governance', event.sourceService, 'lifecycle-v1',
      ${scopePathForEvent(event)}, now(), ${tenant}, ${draft.namespace}::preserve.memory_namespace,
      ${draft.status}::preserve.memory_governance_status, ${draft.sourceClass}::preserve.memory_source_class,
      ${draft.salience}, ${draft.strength}, ${draft.stability}, ${draft.qualityScore}, ${draft.tokenCount},
      ${event.schemaVersion ?? 1}, ${event.configVersion ?? CONFIG_VERSION},
      ${sql.json(redactValue({ lifecycleEvent: event }) as any)}, ${draft.trustClass}::preserve.memory_trust_class
    )
    ON CONFLICT (tenant, fingerprint) DO UPDATE SET
      narrative = EXCLUDED.narrative,
      support_count = GREATEST(preserve.memory.support_count, EXCLUDED.support_count),
      confidence = GREATEST(preserve.memory.confidence, EXCLUDED.confidence),
      quality_score = GREATEST(COALESCE(preserve.memory.quality_score, 0), EXCLUDED.quality_score),
      last_supported_at = now(),
      updated_at = now()
    RETURNING memory_id::text, COALESCE(quality_score, confidence, 0.5)::float AS new_quality_score
  `;
  for (const cue of draft.cues) {
    await sql`
      INSERT INTO preserve.memory_cue (memory_id, cue_text, cue_hash, cue_type, extraction_method, confidence, evidence_ref, usefulness_score)
      VALUES (${memory.memory_id}, ${cue.cueText}, ${cue.cueHash}, ${cue.cueType}, ${cue.extractionMethod}, ${cue.confidence}, ${cue.evidenceRef ?? null}, ${cue.usefulnessScore})
      ON CONFLICT (memory_id, cue_hash) DO UPDATE SET
        confidence = GREATEST(preserve.memory_cue.confidence, EXCLUDED.confidence),
        usefulness_score = GREATEST(preserve.memory_cue.usefulness_score, EXCLUDED.usefulness_score)
    `;
  }
  await recordQualityAudit(sql, {
    memoryId: memory.memory_id,
    tenant,
    triggerType: existing ? 'lifecycle_upsert' : 'write',
    previousQualityScore: existing?.previous_quality_score ?? null,
    newQualityScore: memory.new_quality_score ?? draft.qualityScore,
    qualityFactors: qualityFactorsForLifecycleEvent(event, draft),
  });
  return memory.memory_id;
}

function lifecycleRowToEvent(row: any): MemoryLifecycleEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    sourceService: row.source_service,
    idempotencyKey: row.idempotency_key,
    tenant: row.tenant,
    projectEntityId: row.project_entity_id ?? undefined,
    episodeId: row.episode_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    spanId: row.span_id ?? undefined,
    actorType: row.actor_type ?? undefined,
    actorId: row.actor_id ?? undefined,
    occurredAt: row.occurred_at,
    sensitivityClass: row.sensitivity_class ?? undefined,
    redactionStatus: row.redaction_status ?? undefined,
    payload: row.payload ?? {},
    evidenceRefs: row.evidence_refs ?? [],
    schemaVersion: row.schema_version ?? 1,
    configVersion: row.config_version ?? CONFIG_VERSION,
  };
}

function summarizeLifecycleEvent(event: MemoryLifecycleEvent): string {
  const payload = redactValue(event.payload ?? {}) as Record<string, unknown>;
  return [
    `Event ${event.eventType} from ${event.sourceService}.`,
    event.episodeId ? `Episode ${event.episodeId}.` : "",
    typeof payload.summary === "string" ? redactText(payload.summary) : "",
    payload.result !== undefined ? `Result: ${safeJsonSummary(payload.result)}.` : "",
    payload.error !== undefined ? `Error: ${safeJsonSummary(payload.error)}.` : "",
  ].filter(Boolean).join(" ");
}

function extractLifecycleCues(event: MemoryLifecycleEvent): MemoryCue[] {
  const payload = redactValue(event.payload ?? {}) as Record<string, unknown>;
  const values = [event.eventType, event.sourceService, payload.goal, payload.action, payload.toolName, payload.errorClass];
  if (Array.isArray(payload.cues)) values.push(...payload.cues);
  const templateCues = [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))]
    .map((cueText) => ({
      cueText: normalizeCueText(cueText),
      cueHash: sha256(normalizeCueText(cueText)),
      cueType: cueTypeForText(cueText),
      extractionMethod: "template" as const,
      confidence: 0.85,
      evidenceRef: event.eventId,
      usefulnessScore: 0.5,
    }));
  const text = [payload.summary, payload.result, payload.error]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => typeof value === "string" ? value : safeJsonSummary(value))
    .join(" ");
  const keywordCues = extractKeywordCues(text, event.eventId);
  const seen = new Set<string>();
  return [...templateCues, ...keywordCues]
    .filter((cue) => {
      if (seen.has(cue.cueHash)) return false;
      seen.add(cue.cueHash);
      return true;
    })
    .slice(0, 12);
}

function scoreQuality(event: MemoryLifecycleEvent, cues: MemoryCue[]): number {
  const evidence = (event.evidenceRefs?.length ?? 0) > 0 ? 0.25 : 0.05;
  const source = sourceReliability(event) * 0.35;
  const extraction = cues.length > 0 ? 0.2 : 0.05;
  const validation = event.eventType === "user_corrected" || event.eventType === "approval_decided" ? 0.2 : 0.1;
  return clamp01(evidence + source + extraction + validation);
}

function scoreSalience(event: MemoryLifecycleEvent): number {
  const failure = event.eventType.includes("failed") ? 0.25 : 0;
  const correction = event.eventType === "user_corrected" ? 0.3 : 0;
  const completion = event.eventType.includes("completed") ? 0.15 : 0;
  const explicit = typeof event.payload?.salience === "number" ? Number(event.payload.salience) * 0.3 : 0;
  return clamp01(0.25 + failure + correction + completion + explicit);
}

function sourceReliability(event: MemoryLifecycleEvent): number {
  if (event.eventType === "user_corrected") return 1;
  if (event.sourceService === "approval-service") return 0.9;
  if (event.sourceService.includes("agent") || event.sourceService.includes("orchestrator")) return 0.75;
  return 0.6;
}

function sourceClassForEvent(eventType: string): MemorySourceClass {
  if (eventType === "user_corrected") return "corrected_by_user";
  if (eventType === "approval_decided") return "user_stated";
  if (eventType.includes("completed") || eventType.includes("failed")) return "observed";
  return "system_inferred";
}

function trustClassForSource(sourceClass: MemorySourceClass): MemoryTrustClass {
  if (sourceClass === 'corrected_by_user' || sourceClass === 'user_stated') return 'human_curated';
  if (sourceClass === 'observed') return 'deterministic';
  if (sourceClass === 'imported_knowledge') return 'corroborated_llm';
  return 'single_source_llm';
}

function namespaceForEvent(eventType: string): MemoryNamespace {
  if (eventType === "approval_decided" || eventType.includes("policy")) return "policy";
  if (eventType.includes("tool") || eventType.includes("failed")) return "episodic";
  if (eventType.includes("session") || eventType.includes("mission")) return "episodic";
  return "semantic";
}

function scopePathForEvent(event: MemoryLifecycleEvent): string {
  if (event.episodeId) return `episode:${event.episodeId}`;
  if (event.projectEntityId) return `project:${event.projectEntityId}`;
  return `source:${event.sourceService}`;
}


export function applyResultBudget(results: MemoryPromptResult[], maxTokens = 800, relevanceReason?: string): MemoryPromptResult[] {
  if (maxTokens <= 0) return [];
  const selected: MemoryPromptResult[] = [];
  let remaining = maxTokens;
  for (const result of [...results].sort((a, b) => rankMemoryForPrompt(b) - rankMemoryForPrompt(a))) {
    if (!isRecallEligible(result)) continue;
    if (result.tokenCount <= remaining) {
      selected.push({ ...result, relevanceReason: relevanceReason ?? result.relevanceReason });
      remaining -= result.tokenCount;
      if (remaining <= 0) break;
      continue;
    }
    if (selected.length === 0 && remaining > 0) {
      const budgeted = applyTokenBudget(result.content, remaining);
      selected.push({
        ...result,
        content: budgeted.content,
        tokenCount: budgeted.tokenCount,
        truncated: budgeted.truncated,
        relevanceReason: relevanceReason ?? result.relevanceReason,
      });
      break;
    }
  }
  return selected;
}

export function packageMemoriesForPrompt(results: MemoryPromptResult[], mode: ContextInjectionMode = 'shadow', maxTokens = 800): PromptPackageItem[] {
  if (mode === 'off') return [];
  const packaged: PromptPackageItem[] = [];
  let remaining = maxTokens;
  for (const result of [...results].sort((a, b) => rankMemoryForPrompt(b) - rankMemoryForPrompt(a))) {
    if (!isRecallEligible(result)) continue;
    if (result.tokenCount > remaining) continue;
    packaged.push({
      section: sectionForMemory(result),
      memoryId: result.memoryId,
      role: roleForMemory(result),
      reason: result.relevanceReason ?? `Matched ${result.title ?? result.memoryId}`,
      content: result.content,
      qualityScore: result.qualityScore,
      tokenCount: result.tokenCount,
      governanceStatus: result.governanceStatus,
    });
    remaining -= result.tokenCount;
    if (remaining <= 0) break;
  }
  return packaged;
}

export function omitReason(result: MemoryPromptResult, packagedIds = new Set<string>(), mode: ContextInjectionMode = 'shadow'): string {
  if (result.governanceStatus === 'quarantined') return 'quarantined';
  if (result.governanceStatus === 'suppressed') return 'suppressed';
  if (result.governanceStatus === 'retired') return 'retired';
  if (result.trustClass === 'retired_superseded') return 'retired_superseded';
  if (mode === 'off') return 'injection_mode_off';
  if (!packagedIds.has(result.memoryId)) return 'token_budget_or_low_rank';
  return 'included';
}

export function rankMemoryForPrompt(result: MemoryPromptResult): number {
  const quality = result.qualityScore ?? result.confidence ?? 0.5;
  const corrected = result.sourceClass === 'corrected_by_user' ? 0.2 : 0;
  const validated = result.governanceStatus === 'validated' ? 0.15 : 0;
  const priorityBoost = result.priority ? (11 - result.priority) / 50 : 0;
  return result.score + quality + corrected + validated + (result.strength ?? 0) * 0.2 + priorityBoost;
}

export function scoreFreshness(updatedAt: Date, now = new Date(), halflifeMs = 24 * 60 * 60 * 1000): number {
  const ageMs = Math.max(0, now.getTime() - updatedAt.getTime());
  return clamp01(Math.pow(0.5, ageMs / halflifeMs));
}

export function scoreMemoryConfidence(input: { qualityScore?: number; confidence?: number; supportCount?: number; contradictionCount?: number; freshness?: number }): number {
  const base = input.qualityScore ?? input.confidence ?? 0.5;
  const support = Math.min(0.2, (input.supportCount ?? 0) * 0.03);
  const contradiction = Math.min(0.3, (input.contradictionCount ?? 0) * 0.08);
  const freshness = (input.freshness ?? 1) * 0.1;
  return clamp01(base + support + freshness - contradiction);
}

function isRecallEligible(result: MemoryPromptResult): boolean {
  return isPromptEligible(result.governanceStatus) && result.trustClass !== 'retired_superseded';
}

function sectionForMemory(result: MemoryPromptResult): string {
  if (result.namespace === 'policy') return 'policy_and_user_corrected_memory';
  if (result.governanceStatus === 'disputed' || /\b(error|fail|failed|failure)\b/i.test(`${result.title ?? ''} ${result.content}`)) return 'failure_warnings';
  if (result.namespace === 'procedural') return 'procedural_suggestions';
  if (result.namespace === 'episodic') return 'episodic_context';
  return 'validated_facts';
}

function roleForMemory(result: MemoryPromptResult): PromptMemoryRole {
  if (/\b(error|fail|failed|failure)\b/i.test(`${result.title ?? ''} ${result.content}`)) return 'warning';
  if (result.namespace === 'procedural') return 'guidance';
  if (result.governanceStatus === 'disputed' || result.governanceStatus === 'review_required') return 'uncertainty';
  if (result.namespace === 'episodic') return 'context';
  return 'fact';
}

function contextQueryText(request: ContextRecallRequest): string {
  return [request.goal, request.actionType, ...(request.cues ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .trim();
}

function rowToPromptResult(row: any, relevanceReason?: string): MemoryPromptResult {
  const content = redactText(row.narrative ?? '');
  const tokenCount = Number(row.token_count ?? estimateTokenCount(content));
  const textRank = Number(row.text_rank ?? 0);
  const qualityScore = optionalNumber(row.quality_score);
  const confidence = optionalNumber(row.confidence);
  const strength = optionalNumber(row.strength);
  return {
    memoryId: row.memory_id,
    memoryType: row.memory_type ?? undefined,
    title: row.title ?? undefined,
    content,
    confidence,
    namespace: row.namespace as MemoryNamespace | undefined,
    governanceStatus: row.governance_status as MemoryGovernanceStatus | undefined,
    sourceClass: row.source_class as MemorySourceClass | undefined,
    trustClass: row.trust_class as MemoryTrustClass | undefined,
    qualityScore,
    strength,
    priority: row.priority === null || row.priority === undefined ? undefined : Number(row.priority),
    scopePath: row.scope_path ?? undefined,
    tokenCount,
    score: textRank,
    relevanceReason,
  };
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function qualityFactorsForLifecycleEvent(event: MemoryLifecycleEvent, draft: GovernedMemoryDraft): Record<string, unknown> {
  return {
    eventType: event.eventType,
    sourceService: event.sourceService,
    sourceClass: draft.sourceClass,
    salience: draft.salience,
    strength: draft.strength,
    stability: draft.stability,
    cueCount: draft.cues.length,
    evidenceCount: event.evidenceRefs?.length ?? 0,
  };
}

function extractKeywordCues(text: string, evidenceRef?: string): MemoryCue[] {
  if (!text.trim()) return [];
  const matches = text
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word))
    .slice(0, 24);
  return [...new Set(matches)].slice(0, 8).map((cueText) => ({
    cueText: normalizeCueText(cueText),
    cueHash: sha256(normalizeCueText(cueText)),
    cueType: cueTypeForText(cueText),
    extractionMethod: 'keyword' as const,
    confidence: 0.55,
    evidenceRef,
    usefulnessScore: 0.35,
  }));
}

const STOP_WORDS = new Set(['that', 'this', 'with', 'from', 'have', 'will', 'into', 'when', 'then', 'than', 'were', 'been', 'memory', 'event']);

function feedbackDelta(signal: string): { strength: number; stability: number; quality: number } {
  switch (signal) {
    case "injected_referenced":
    case "led_to_success":
    case "user_confirmed":
    case "admin_promoted":
      return { strength: 0.05, stability: 0.03, quality: 0.04 };
    case "injected_contradicted":
    case "led_to_failure":
    case "user_corrected":
      return { strength: -0.08, stability: -0.03, quality: -0.08 };
    case "admin_suppressed":
      return { strength: -0.2, stability: -0.05, quality: -0.15 };
    default:
      return { strength: 0, stability: 0, quality: 0 };
  }
}

function cueTypeForText(value: string): string {
  const text = value.toLowerCase();
  if (text.includes("fail") || text.includes("error")) return "failure_mode";
  if (text.includes("tool")) return "tool";
  if (text.includes("policy") || text.includes("approval")) return "policy";
  if (text.includes("/") || text.includes(".ts") || text.includes(".md")) return "file_path";
  if (text.includes("mission") || text.includes("goal")) return "goal";
  return "action";
}

function normalizeCueText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

function safeJsonSummary(value: unknown): string {
  try {
    return JSON.stringify(redactValue(value)).slice(0, 500);
  } catch {
    return redactText(String(value)).slice(0, 500);
  }
}

function sanitizeErrorSummary(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactText(message).slice(0, 500);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validUniqueMemoryIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const id of ids) {
    if (!UUID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  return valid;
}

async function tenantScopedMemoryIds(sql: postgres.Sql, tenant: string, ids: string[]): Promise<string[]> {
  const validIds = validUniqueMemoryIds(ids);
  if (validIds.length === 0) return [];
  const rows = await sql`
    SELECT memory_id::text
    FROM preserve.memory
    WHERE tenant = ${tenant}
      AND memory_id = ANY(${validIds}::uuid[])
  `;
  const allowed = new Set(rows.map((row: any) => row.memory_id));
  return validIds.filter((id) => allowed.has(id));
}

function filteredOmissions(omitted: Array<{ memoryId: string; reason: string }>, allowedMemoryIds: Set<string>): Array<{ memoryId: string; reason: string }> {
  return omitted
    .filter((item) => allowedMemoryIds.has(item.memoryId))
    .map((item) => redactValue(item));
}

function filteredPromptPackage(promptPackage: unknown[], allowedMemoryIds: Set<string>): unknown[] {
  if (!Array.isArray(promptPackage)) return [];
  return promptPackage
    .filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const memoryId = (item as { memoryId?: unknown }).memoryId;
      return typeof memoryId === 'string' && allowedMemoryIds.has(memoryId);
    })
    .map((item) => redactValue(item));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
