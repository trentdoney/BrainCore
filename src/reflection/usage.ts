import { createHash } from "crypto";
import type postgres from "postgres";
import { config } from "../config";
import { classifyMemoryHealth, type HealthStatus } from "./health";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface MemoryUsageOptions {
  tenant?: string;
  scope?: string;
  source?: string;
  measuredAt?: Date;
}

export interface MemoryUsageSnapshot {
  tenant: string;
  scopePath: string | null;
  measuredAt: Date;
  source: string;
  usageFingerprint: string;
  totalMemoryCount: number;
  publishedCount: number;
  draftCount: number;
  retiredCount: number;
  unsupportedCount: number;
  staleCount: number;
  contradictionCount: number;
  avgConfidence: number | null;
  byteEstimate: number | null;
  metrics: {
    staleAfterDays: number;
    unsupportedRatio: number;
    staleRatio: number;
    contradictionRatio: number;
  };
}

export interface RecordedMemoryUsage extends MemoryUsageSnapshot {
  usageId: string;
}

export interface MemoryHealthDecision {
  tenant: string;
  usageId: string;
  scopePath: string | null;
  healthFingerprint: string;
  status: HealthStatus;
  riskScore: number;
  assessmentText: string;
  recommendations: string[];
  assessedAt: Date;
}

export interface RecordedMemoryHealth extends MemoryHealthDecision {
  healthId: string;
}

export interface RecordUsageResult {
  usage: RecordedMemoryUsage;
  inserted: boolean;
}

export interface AssessHealthResult {
  health: RecordedMemoryHealth;
  inserted: boolean;
}

export type RetentionProposalType = "refresh" | "demote" | "retire";

export interface MemoryRetentionReviewCandidate {
  tenant: string;
  memoryId: string;
  title: string;
  scopePath: string | null;
  proposalType: RetentionProposalType;
  reason: string;
  riskScore: number;
}

export interface RetentionReviewOptions extends MemoryUsageOptions {
  limit?: number;
}

export interface RetentionReviewResult {
  proposed: number;
  inserted: number;
}

const STALE_AFTER_DAYS = 180;

function normalizePart(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function sha256(parts: string[]): string {
  return createHash("sha256").update(parts.join("|"), "utf-8").digest("hex");
}

function toCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function ratio(count: number, total: number): number {
  if (total <= 0) return 0;
  return clampScore(count / total);
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function memoryUsageFingerprint(input: {
  tenant: string;
  scopePath?: string | null;
  source: string;
  measuredAt: Date;
}): string {
  return sha256([
    "memory-usage-v1",
    `tenant=${normalizePart(input.tenant)}`,
    `scope=${normalizePart(input.scopePath)}`,
    `source=${normalizePart(input.source)}`,
    `measured_at=${input.measuredAt.toISOString()}`,
  ]);
}

export function memoryHealthFingerprint(input: {
  tenant: string;
  usageId: string;
  scopePath?: string | null;
}): string {
  return sha256([
    "memory-health-v1",
    `tenant=${normalizePart(input.tenant)}`,
    `usage=${normalizePart(input.usageId)}`,
    `scope=${normalizePart(input.scopePath)}`,
  ]);
}

export async function collectMemoryUsage(
  sql: postgres.Sql,
  options: MemoryUsageOptions = {},
): Promise<MemoryUsageSnapshot> {
  const tenant = options.tenant ?? config.tenant;
  const scope = options.scope?.trim() || null;
  const source = options.source?.trim() || "manual";
  const measuredAt = options.measuredAt ?? new Date();

  const [row] = await sql`
    SELECT
      count(*) AS total_memory_count,
      count(*) FILTER (WHERE m.lifecycle_state = 'published') AS published_count,
      count(*) FILTER (WHERE m.lifecycle_state = 'draft') AS draft_count,
      count(*) FILTER (WHERE m.lifecycle_state = 'retired') AS retired_count,
      count(*) FILTER (
        WHERE COALESCE(m.support_count, 0) = 0
          AND COALESCE(m.lifecycle_state::text, 'draft') != 'retired'
      ) AS unsupported_count,
      count(*) FILTER (
        WHERE m.lifecycle_state = 'published'
          AND (
            m.last_supported_at IS NULL
            OR m.last_supported_at < ${measuredAt}::timestamptz - (${STALE_AFTER_DAYS}::text || ' days')::interval
          )
      ) AS stale_count,
      COALESCE(sum(COALESCE(m.contradiction_count, 0)), 0) AS contradiction_count,
      avg(m.confidence)::float AS avg_confidence,
      COALESCE(sum(octet_length(COALESCE(m.title, '') || COALESCE(m.narrative, ''))), 0) AS byte_estimate
    FROM preserve.memory m
    WHERE m.tenant = ${tenant}
      AND (${scope}::text IS NULL OR COALESCE(m.scope_path, '') LIKE (${scope ?? ""} || '%'))
  `;

  const totalMemoryCount = toCount(row?.total_memory_count);
  const unsupportedCount = toCount(row?.unsupported_count);
  const staleCount = toCount(row?.stale_count);
  const contradictionCount = toCount(row?.contradiction_count);

  return {
    tenant,
    scopePath: scope,
    measuredAt,
    source,
    usageFingerprint: memoryUsageFingerprint({ tenant, scopePath: scope, source, measuredAt }),
    totalMemoryCount,
    publishedCount: toCount(row?.published_count),
    draftCount: toCount(row?.draft_count),
    retiredCount: toCount(row?.retired_count),
    unsupportedCount,
    staleCount,
    contradictionCount,
    avgConfidence: toNullableNumber(row?.avg_confidence),
    byteEstimate: toNullableNumber(row?.byte_estimate),
    metrics: {
      staleAfterDays: STALE_AFTER_DAYS,
      unsupportedRatio: ratio(unsupportedCount, totalMemoryCount),
      staleRatio: ratio(staleCount, totalMemoryCount),
      contradictionRatio: ratio(contradictionCount, totalMemoryCount),
    },
  };
}

export async function recordMemoryUsage(
  sql: postgres.Sql,
  options: MemoryUsageOptions = {},
): Promise<RecordUsageResult> {
  const usage = await collectMemoryUsage(sql, options);
  const rows = await sql`
    INSERT INTO preserve.memory_usage (
      tenant,
      scope_path,
      measured_at,
      source,
      usage_fingerprint,
      total_memory_count,
      published_count,
      draft_count,
      retired_count,
      unsupported_count,
      stale_count,
      contradiction_count,
      avg_confidence,
      byte_estimate,
      metrics
    )
    VALUES (
      ${usage.tenant},
      ${usage.scopePath},
      ${usage.measuredAt},
      ${usage.source},
      ${usage.usageFingerprint},
      ${usage.totalMemoryCount},
      ${usage.publishedCount},
      ${usage.draftCount},
      ${usage.retiredCount},
      ${usage.unsupportedCount},
      ${usage.staleCount},
      ${usage.contradictionCount},
      ${usage.avgConfidence},
      ${usage.byteEstimate},
      ${sql.json(toJson(usage.metrics))}
    )
    ON CONFLICT (tenant, usage_fingerprint) DO UPDATE
      SET total_memory_count = EXCLUDED.total_memory_count,
          published_count = EXCLUDED.published_count,
          draft_count = EXCLUDED.draft_count,
          retired_count = EXCLUDED.retired_count,
          unsupported_count = EXCLUDED.unsupported_count,
          stale_count = EXCLUDED.stale_count,
          contradiction_count = EXCLUDED.contradiction_count,
          avg_confidence = EXCLUDED.avg_confidence,
          byte_estimate = EXCLUDED.byte_estimate,
          metrics = EXCLUDED.metrics
    RETURNING usage_id::text AS usage_id, (xmax = 0) AS inserted
  `;
  const row = rows[0];
  return {
    usage: {
      ...usage,
      usageId: String(row.usage_id),
    },
    inserted: Boolean(row.inserted),
  };
}

export function decideMemoryHealth(input: {
  usage: Pick<RecordedMemoryUsage, "tenant" | "usageId" | "scopePath" | "totalMemoryCount" | "unsupportedCount" | "staleCount" | "contradictionCount" | "metrics">;
  assessedAt?: Date;
}): MemoryHealthDecision {
  const assessedAt = input.assessedAt ?? new Date();
  const { usage } = input;
  const status = classifyMemoryHealth({
    totalMemoryCount: usage.totalMemoryCount,
    unsupportedCount: usage.unsupportedCount,
    staleCount: usage.staleCount,
    contradictionCount: usage.contradictionCount,
  });
  const riskScore = clampScore(
    usage.metrics.unsupportedRatio * 0.45
      + usage.metrics.staleRatio * 0.25
      + usage.metrics.contradictionRatio * 0.30
      + (status === "critical" ? 0.35 : status === "degraded" ? 0.2 : status === "watch" ? 0.08 : 0),
  );
  const recommendations: string[] = [];
  if (usage.unsupportedCount > 0) {
    recommendations.push("Add or relink evidence for unsupported active memories.");
  }
  if (usage.staleCount > 0) {
    recommendations.push(`Refresh published memories without support in the last ${STALE_AFTER_DAYS} days.`);
  }
  if (usage.contradictionCount > 0) {
    recommendations.push("Review contradicted memories before promotion or publication.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Continue normal retention cadence.");
  }

  return {
    tenant: usage.tenant,
    usageId: usage.usageId,
    scopePath: usage.scopePath,
    healthFingerprint: memoryHealthFingerprint({
      tenant: usage.tenant,
      usageId: usage.usageId,
      scopePath: usage.scopePath,
    }),
    status,
    riskScore,
    assessmentText: [
      `${status} memory health for ${usage.scopePath ?? "all scopes"}.`,
      `${usage.unsupportedCount}/${usage.totalMemoryCount} unsupported,`,
      `${usage.staleCount}/${usage.totalMemoryCount} stale,`,
      `${usage.contradictionCount} contradictions.`,
    ].join(" "),
    recommendations,
    assessedAt,
  };
}

export async function assessMemoryHealth(
  sql: postgres.Sql,
  options: MemoryUsageOptions = {},
): Promise<AssessHealthResult> {
  const { usage } = await recordMemoryUsage(sql, options);
  const decision = decideMemoryHealth({ usage });
  let health: RecordedMemoryHealth | null = null;
  let inserted = false;

  await sql.begin(async (tx) => {
    const rows = await tx`
      INSERT INTO preserve.memory_health (
        tenant,
        class_key,
        health_fingerprint,
        usage_id,
        scope_path,
        status,
        risk_score,
        assessment_text,
        recommendations,
        assertion_class,
        assessed_at
      )
      VALUES (
        ${decision.tenant},
        'memory_health',
        ${decision.healthFingerprint},
        ${decision.usageId},
        ${decision.scopePath},
        ${decision.status},
        ${decision.riskScore},
        ${decision.assessmentText},
        ${tx.json(toJson(decision.recommendations))},
        'deterministic'::preserve.assertion_class,
        ${decision.assessedAt}
      )
      ON CONFLICT (tenant, health_fingerprint) DO UPDATE
        SET status = EXCLUDED.status,
            risk_score = EXCLUDED.risk_score,
            assessment_text = EXCLUDED.assessment_text,
            recommendations = EXCLUDED.recommendations,
            assessed_at = EXCLUDED.assessed_at,
            updated_at = now()
      RETURNING health_id::text AS health_id, (xmax = 0) AS inserted
    `;
    health = {
      ...decision,
      healthId: String(rows[0].health_id),
    };
    inserted = Boolean(rows[0].inserted);

    await tx`
      INSERT INTO preserve.memory_health_evidence (
        health_id,
        usage_id,
        evidence_role,
        weight,
        notes
      )
      VALUES (
        ${health.healthId},
        ${decision.usageId},
        'supporting',
        1.0,
        'Usage snapshot for deterministic memory health assessment'
      )
      ON CONFLICT DO NOTHING
    `;
  });

  if (!health) {
    throw new Error("Memory health assessment did not return a health row");
  }
  return { health, inserted };
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 100, 1000));
}

export async function findMemoryRetentionReviewCandidates(
  sql: postgres.Sql,
  options: RetentionReviewOptions = {},
): Promise<MemoryRetentionReviewCandidate[]> {
  const tenant = options.tenant ?? config.tenant;
  const scope = options.scope?.trim() || null;
  const limit = clampLimit(options.limit);

  const rows = await sql`
    WITH latest_health AS (
      SELECT DISTINCT ON (mh.tenant, COALESCE(mh.scope_path, ''))
        mh.tenant,
        mh.scope_path,
        mh.status,
        mh.risk_score::float AS risk_score
      FROM preserve.memory_health mh
      WHERE mh.tenant = ${tenant}
      ORDER BY mh.tenant, COALESCE(mh.scope_path, ''), mh.assessed_at DESC
    ),
    candidates AS (
      SELECT
        m.memory_id::text,
        COALESCE(m.title, m.fingerprint, m.memory_id::text) AS title,
        m.scope_path,
        CASE
          WHEN COALESCE(m.contradiction_count, 0) > COALESCE(m.support_count, 0)
            THEN 'retire'
          WHEN m.lifecycle_state = 'published'
            AND (
              m.last_supported_at IS NULL
              OR m.last_supported_at < now() - (${STALE_AFTER_DAYS}::text || ' days')::interval
            )
            THEN 'demote'
          ELSE 'refresh'
        END AS proposal_type,
        CASE
          WHEN COALESCE(m.contradiction_count, 0) > COALESCE(m.support_count, 0)
            THEN 'Adaptive retention review: contradictions exceed support; review retirement.'
          WHEN m.lifecycle_state = 'published'
            AND (
              m.last_supported_at IS NULL
              OR m.last_supported_at < now() - (${STALE_AFTER_DAYS}::text || ' days')::interval
            )
            THEN 'Adaptive retention review: published memory is stale; review demotion to draft.'
          ELSE 'Adaptive retention review: active memory lacks evidence support; refresh or relink evidence.'
        END AS reason,
        GREATEST(
          COALESCE(lh.risk_score, 0),
          CASE
            WHEN COALESCE(m.contradiction_count, 0) > COALESCE(m.support_count, 0) THEN 0.90
            WHEN m.lifecycle_state = 'published'
              AND (
                m.last_supported_at IS NULL
                OR m.last_supported_at < now() - (${STALE_AFTER_DAYS}::text || ' days')::interval
              ) THEN 0.70
            ELSE 0.50
          END
        ) AS risk_score
      FROM preserve.memory m
      LEFT JOIN latest_health lh
        ON lh.tenant = m.tenant
       AND (
         lh.scope_path IS NULL
         OR COALESCE(m.scope_path, '') LIKE (lh.scope_path || '%')
       )
      WHERE m.tenant = ${tenant}
        AND (${scope}::text IS NULL OR COALESCE(m.scope_path, '') LIKE (${scope ?? ""} || '%'))
        AND COALESCE(m.lifecycle_state::text, 'draft') != 'retired'
        AND (
          COALESCE(m.support_count, 0) = 0
          OR COALESCE(m.contradiction_count, 0) > COALESCE(m.support_count, 0)
          OR (
            m.lifecycle_state = 'published'
            AND (
              m.last_supported_at IS NULL
              OR m.last_supported_at < now() - (${STALE_AFTER_DAYS}::text || ' days')::interval
            )
          )
        )
    )
    SELECT *
    FROM candidates c
    WHERE NOT EXISTS (
      SELECT 1
      FROM preserve.review_queue rq
      WHERE rq.target_type = 'memory'
        AND rq.target_id = c.memory_id::uuid
        AND rq.status = 'pending'
        AND rq.reason = c.reason
    )
    ORDER BY risk_score DESC, proposal_type, title, memory_id
    LIMIT ${limit}
  `;

  return rows.map((row: any) => ({
    tenant,
    memoryId: String(row.memory_id),
    title: String(row.title),
    scopePath: row.scope_path ?? null,
    proposalType: row.proposal_type as RetentionProposalType,
    reason: String(row.reason),
    riskScore: clampScore(Number(row.risk_score)),
  }));
}

export async function insertMemoryRetentionReviewCandidates(
  candidates: MemoryRetentionReviewCandidate[],
  sql: postgres.Sql,
): Promise<RetentionReviewResult> {
  let inserted = 0;
  await sql.begin(async (tx) => {
    for (const candidate of candidates) {
      const rows = await tx`
        INSERT INTO preserve.review_queue (
          target_type,
          target_id,
          reason,
          status,
          reviewer_notes
        )
        SELECT
          'memory',
          ${candidate.memoryId}::uuid,
          ${candidate.reason},
          'pending',
          ${`proposal=${candidate.proposalType}; risk=${candidate.riskScore.toFixed(2)}; scope=${candidate.scopePath ?? "(none)"}`}
        WHERE NOT EXISTS (
          SELECT 1
          FROM preserve.review_queue rq
          WHERE rq.target_type = 'memory'
            AND rq.target_id = ${candidate.memoryId}::uuid
            AND rq.status = 'pending'
            AND rq.reason = ${candidate.reason}
        )
        RETURNING review_id
      `;
      inserted += rows.length;
    }
  });
  return { proposed: candidates.length, inserted };
}
