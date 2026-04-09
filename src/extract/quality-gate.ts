/**
 * quality-gate.ts — Pre-insertion quality gate for BrainCore facts.
 *
 * Responsibilities:
 * 1. Deduplication: Check canonical_fingerprint before inserting any fact.
 *    If same subject+predicate+fact_kind already exists, UPDATE last_seen_at
 *    instead of inserting a duplicate.
 * 2. Source-type acceptance criteria: Validate that facts meet minimum quality
 *    standards per source type before insertion.
 *
 * Acceptance criteria per source type:
 * - opsvault_incident: must have episode_id, must have segment evidence
 * - codex_session/codex_shared: must have source_key, tagged with source agent
 * - discord_conversation: must have channel reference, dedup by message timestamp
 * - monitoring_alert: must have service+severity, dedup by alert_id+timestamp
 * - telegram_chat: must have message_id, dedup by chat_id+message_id
 * - claude_session: must have source_key
 * - pai_memory: must have scope_path
 */

import type postgres from "postgres";
import { createHash } from "crypto";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface QualityGateResult {
  passed: boolean;
  duplicateCount: number;
  rejectedCount: number;
  acceptedCount: number;
  updatedCount: number;
  reasons: string[];
}

export interface FactCandidate {
  subject: string;
  predicate: string;
  object_value: any;
  fact_kind: string;
  segment_ids: string[];
  confidence?: number;
  [key: string]: any;
}

// ── Fingerprinting ─────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Build canonical fingerprint matching load.ts convention.
 */
function factFingerprint(
  subjectName: string,
  predicate: string,
  objectValue: any,
): string {
  const raw = `${subjectName}|${predicate}|${JSON.stringify(objectValue ?? "")}`;
  return sha256(raw);
}

// ── Source-Specific Validators ─────────────────────────────────────────────────

interface ValidationContext {
  sourceType: string;
  sourceKey?: string;
  episodeId?: string;
  scopePath?: string;
  metadata?: Record<string, any>;
}

function validateOpsVaultIncident(
  fact: FactCandidate,
  ctx: ValidationContext,
): string | null {
  if (!ctx.episodeId) {
    return `opsvault_incident fact (${fact.subject}/${fact.predicate}) rejected: missing episode_id`;
  }
  if (!fact.segment_ids || fact.segment_ids.length === 0) {
    return `opsvault_incident fact (${fact.subject}/${fact.predicate}) rejected: no segment evidence`;
  }
  return null;
}

function validateCodexSession(
  fact: FactCandidate,
  ctx: ValidationContext,
): string | null {
  if (!ctx.sourceKey) {
    return `codex_session fact (${fact.subject}/${fact.predicate}) rejected: missing source_key`;
  }
  return null;
}

function validateCodexShared(
  fact: FactCandidate,
  ctx: ValidationContext,
): string | null {
  if (!ctx.sourceKey) {
    return `codex_shared fact (${fact.subject}/${fact.predicate}) rejected: missing source_key`;
  }
  return null;
}

function validateClaudeSession(
  fact: FactCandidate,
  ctx: ValidationContext,
): string | null {
  if (!ctx.sourceKey) {
    return `claude_session fact (${fact.subject}/${fact.predicate}) rejected: missing source_key`;
  }
  return null;
}

function validatePAIMemory(
  fact: FactCandidate,
  ctx: ValidationContext,
): string | null {
  if (!ctx.scopePath) {
    return `pai_memory fact (${fact.subject}/${fact.predicate}) rejected: missing scope_path`;
  }
  return null;
}

function validateDiscordConversation(
  fact: FactCandidate,
  ctx: ValidationContext,
): string | null {
  // Channel reference is embedded in fact.subject (e.g., "discord:general")
  // or passed via metadata. Accept if either is present.
  const hasChannelInSubject = fact.subject?.startsWith("discord:");
  const hasChannelInMeta = !!ctx.metadata?.channel_ref;
  if (!hasChannelInSubject && !hasChannelInMeta) {
    return `discord_conversation fact (${fact.subject}/${fact.predicate}) rejected: missing channel reference`;
  }
  return null;
}

function validateMonitoringAlert(
  fact: FactCandidate,
  ctx: ValidationContext,
): string | null {
  // Resolve service/severity from any of:
  //  1. Per-fact metadata (preferred — grafana-parser populates this)
  //  2. Embedded in object_value (alert_fired facts from grafana-parser)
  //  3. The fact itself (severity/tagged_service predicates carry the value)
  //  4. Batch-level ctx.metadata (legacy path / other ingestion sources)
  const factMeta = (fact as any).metadata as Record<string, any> | undefined;
  const objVal = fact.object_value;
  const isObj = objVal && typeof objVal === "object" && !Array.isArray(objVal);

  const service =
    factMeta?.service ||
    (isObj ? objVal.service : undefined) ||
    (fact.predicate === "tagged_service" && typeof objVal === "string"
      ? objVal
      : undefined) ||
    ctx.metadata?.service;

  const severity =
    factMeta?.severity ||
    (isObj ? objVal.severity : undefined) ||
    (fact.predicate === "severity" && typeof objVal === "string"
      ? objVal
      : undefined) ||
    ctx.metadata?.severity;

  if (!service || !severity) {
    return `monitoring_alert fact (${fact.subject}/${fact.predicate}) rejected: missing service or severity`;
  }
  return null;
}

function validateTelegramChat(
  fact: FactCandidate,
  ctx: ValidationContext,
): string | null {
  if (!ctx.metadata?.message_id) {
    return `telegram_chat fact (${fact.subject}/${fact.predicate}) rejected: missing message_id`;
  }
  return null;
}

const VALIDATORS: Record<
  string,
  (fact: FactCandidate, ctx: ValidationContext) => string | null
> = {
  opsvault_incident: validateOpsVaultIncident,
  codex_session: validateCodexSession,
  codex_shared: validateCodexShared,
  claude_session: validateClaudeSession,
  pai_memory: validatePAIMemory,
  discord_conversation: validateDiscordConversation,
  monitoring_alert: validateMonitoringAlert,
  telegram_chat: validateTelegramChat,
};

// ── Deduplication Check ────────────────────────────────────────────────────────

interface DedupResult {
  isDuplicate: boolean;
  existingFactId?: string;
}

/**
 * Check if a fact with the same canonical fingerprint already exists.
 * If it does and has the same fact_kind, it's a duplicate — update last_seen_at.
 */
async function checkDuplicate(
  fingerprint: string,
  factKind: string,
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<DedupResult> {
  const rows = await sql`
    SELECT fact_id, fact_kind::text, last_seen_at
    FROM preserve.fact
    WHERE canonical_fingerprint = ${fingerprint}
    LIMIT 1
  `.catch(() => [] as any[]);

  if (rows.length === 0) {
    return { isDuplicate: false };
  }

  const existing = rows[0];

  // Same fingerprint AND same fact_kind = true duplicate
  if (existing.fact_kind === factKind) {
    // Touch last_seen_at
    await sql`
      UPDATE preserve.fact
      SET last_seen_at = now()
      WHERE fact_id = ${existing.fact_id}::uuid
    `.catch(() => {});

    return { isDuplicate: true, existingFactId: existing.fact_id };
  }

  // Same fingerprint but different fact_kind = different intent, allow
  return { isDuplicate: false };
}

// ── Main Quality Gate ──────────────────────────────────────────────────────────

/**
 * Run quality gate on a batch of fact candidates before insertion.
 *
 * Returns which facts passed, which were duplicates (updated last_seen_at),
 * and which were rejected with reasons.
 *
 * The caller should only insert facts where `passedFacts` includes them.
 */
export async function checkQualityGate(
  facts: FactCandidate[],
  sourceType: string,
  sql: postgres.Sql | postgres.TransactionSql,
  context?: {
    sourceKey?: string;
    episodeId?: string;
    scopePath?: string;
    metadata?: Record<string, any>;
  },
): Promise<QualityGateResult & { passedFacts: FactCandidate[] }> {
  const reasons: string[] = [];
  let duplicateCount = 0;
  let rejectedCount = 0;
  let updatedCount = 0;
  const passedFacts: FactCandidate[] = [];

  const ctx: ValidationContext = {
    sourceType,
    sourceKey: context?.sourceKey,
    episodeId: context?.episodeId,
    scopePath: context?.scopePath,
    metadata: context?.metadata,
  };

  const validator = VALIDATORS[sourceType];

  for (const fact of facts) {
    // Step 1: Source-type acceptance criteria
    if (validator) {
      const rejection = validator(fact, ctx);
      if (rejection) {
        reasons.push(rejection);
        rejectedCount++;
        continue;
      }
    }

    // Step 2: Dedup check via canonical fingerprint
    const fingerprint = factFingerprint(
      fact.subject,
      fact.predicate,
      fact.object_value,
    );

    const dedup = await checkDuplicate(fingerprint, fact.fact_kind, sql);

    if (dedup.isDuplicate) {
      duplicateCount++;
      updatedCount++;
      reasons.push(
        `Duplicate: (${fact.subject}, ${fact.predicate}) fingerprint=${fingerprint.slice(0, 12)}... — updated last_seen_at`,
      );
      continue;
    }

    // Step 3: Basic quality checks (universal)
    if (!fact.subject || fact.subject.trim() === "") {
      reasons.push(`Rejected: empty subject for predicate=${fact.predicate}`);
      rejectedCount++;
      continue;
    }

    if (!fact.predicate || fact.predicate.trim() === "") {
      reasons.push(`Rejected: empty predicate for subject=${fact.subject}`);
      rejectedCount++;
      continue;
    }

    if (
      fact.confidence !== undefined &&
      (fact.confidence < 0 || fact.confidence > 1)
    ) {
      reasons.push(
        `Rejected: invalid confidence ${fact.confidence} for (${fact.subject}, ${fact.predicate})`,
      );
      rejectedCount++;
      continue;
    }

    passedFacts.push(fact);
  }

  const acceptedCount = passedFacts.length;
  const passed = rejectedCount === 0;

  return {
    passed,
    duplicateCount,
    rejectedCount,
    acceptedCount,
    updatedCount,
    reasons,
    passedFacts,
  };
}
