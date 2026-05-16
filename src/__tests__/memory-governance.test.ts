import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import postgres from "postgres";
import { readFileSync } from "fs";
import { join } from "path";
import {
  applyResultBudget,
  applyTokenBudget,
  draftFromLifecycleEvent,
  estimateTokenCount,
  auditPromptRead,
  isPromptEligible,
  omitReason,
  packageMemoriesForPrompt,
  redactValue,
  recordMemoryFeedback,
  recordQualityAudit,
  searchForPrompt,
  scoreFreshness,
  scoreMemoryConfidence,
  type MemoryPromptResult,
} from "../memory/governance";

process.env.BRAINCORE_POSTGRES_DSN ??= ["postgresql", "://", "postgres:postgres@localhost:5432/postgres"].join("");

describe("memory governance helpers", () => {
  test("keeps non-recallable governance statuses out of prompt defaults", () => {
    expect(isPromptEligible("active")).toBe(true);
    expect(isPromptEligible("validated")).toBe(true);
    expect(isPromptEligible("archived")).toBe(false);
    expect(isPromptEligible("quarantined")).toBe(false);
    expect(isPromptEligible("suppressed")).toBe(false);
    expect(isPromptEligible("retired")).toBe(false);
  });

  test("redacts secret-shaped lifecycle payload values", () => {
    const redacted = redactValue({
      note: "Bearer abc123token456def789ghi012jkl345",
      nested: { token: "fake-secret-memory-core" },
    });
    const text = JSON.stringify(redacted);
    expect(text).toContain("Bearer [REDACTED]");
    expect(text).toContain("[REDACTED_SECRET]");
    expect(text).not.toContain("abc123token456def789ghi012jkl345");
    expect(text).not.toContain("fake-secret-memory-core");
  });

  test("redacts lifecycle summaries before they become memory narratives", () => {
    const draft = draftFromLifecycleEvent({
      eventId: "evt-redact",
      eventType: "session_completed",
      sourceService: "agent-runtime",
      payload: {
        summary: "Bearer abc123token456def789ghi012jkl345 should not persist",
        result: { api_key: "sk-1234567890abcdefghijklmnop" },
        error: "password=supersecretvalue should not persist",
      },
    });
    expect(draft.narrative).not.toContain("abc123token456def789ghi012jkl345");
    expect(draft.narrative).not.toContain("supersecretvalue");
    expect(draft.narrative).toContain("[REDACTED");
  });

  test("forms governed draft memory from lifecycle events", () => {
    const draft = draftFromLifecycleEvent({
      eventId: "evt-1",
      eventType: "session_completed",
      sourceService: "agent-runtime",
      payload: { goal: "upgrade memory", summary: "Implemented recall governance." },
      evidenceRefs: [{ kind: "test", id: "memory-governance" }],
    });
    expect(draft.namespace).toBe("episodic");
    expect(draft.status).toBe("active");
    expect(draft.sourceClass).toBe("observed");
    expect(draft.qualityScore).toBeGreaterThan(0.5);
    expect(draft.cues.map((cue) => cue.cueText)).toContain("session_completed");
  });

  test("applies prompt token budgets without expanding content", () => {
    const content = "alpha beta gamma delta epsilon zeta eta theta iota";
    const budgeted = applyTokenBudget(content, 4);
    expect(budgeted.truncated).toBe(true);
    expect(budgeted.tokenCount).toBeLessThanOrEqual(estimateTokenCount(content));
    expect(budgeted.content.length).toBeLessThan(content.length);
  });

  test("packages context recall memories with budget and omission reasons", () => {
    const results: MemoryPromptResult[] = [
      {
        memoryId: "11111111-1111-1111-1111-111111111111",
        memoryType: "heuristic",
        content: "Use the memory governance policy before prompt injection.",
        namespace: "policy",
        governanceStatus: "validated",
        sourceClass: "corrected_by_user",
        qualityScore: 0.9,
        strength: 0.8,
        tokenCount: 8,
        score: 0.5,
      },
      {
        memoryId: "22222222-2222-2222-2222-222222222222",
        memoryType: "heuristic",
        content: "Suppressed content should not be injected.",
        namespace: "semantic",
        governanceStatus: "suppressed",
        tokenCount: 6,
        score: 1,
      },
    ];

    const budgeted = applyResultBudget(results, 20, "context:test");
    const packaged = packageMemoriesForPrompt(budgeted, "default_on", 20);

    expect(packaged).toHaveLength(1);
    expect(packaged[0].section).toBe("policy_and_user_corrected_memory");
    expect(packaged[0].role).toBe("fact");
    expect(omitReason(results[1])).toBe("suppressed");
    expect(omitReason({ ...results[0], trustClass: "retired_superseded" })).toBe("retired_superseded");
  });

  test("search prompt defaults exclude governed and retired-superseded memories", async () => {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ query: strings.join("?"), values });
      return Promise.resolve([]);
    }) as any;

    await searchForPrompt(fakeSql, { trigger: "manual", goal: "memory governance" });

    expect(calls).toHaveLength(1);
    expect(calls[0].values).toContain(false);
    expect(calls[0].query).toContain("m.governance_status NOT IN ('archived','quarantined','suppressed','retired')");
    expect(calls[0].query).toContain("retired_superseded");
  });

  test("search prompt operator override can include governed memories for audit", async () => {
    const calls: Array<{ values: unknown[] }> = [];
    const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ values });
      return Promise.resolve([]);
    }) as any;

    await searchForPrompt(fakeSql, { trigger: "manual", goal: "memory governance", includeExcluded: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].values).toContain(true);
  });

  test("scores freshness and confidence with support and contradictions", () => {
    const now = new Date("2026-05-16T00:00:00Z");
    expect(scoreFreshness(now, now)).toBe(1);
    expect(scoreFreshness(new Date("2026-05-15T00:00:00Z"), now)).toBeCloseTo(0.5, 2);
    expect(scoreMemoryConfidence({ qualityScore: 0.6, supportCount: 2, contradictionCount: 0, freshness: 1 })).toBeGreaterThan(0.6);
    expect(scoreMemoryConfidence({ qualityScore: 0.6, supportCount: 0, contradictionCount: 3, freshness: 0 })).toBeLessThan(0.6);
  });

  test("wires required memory governance functions", () => {
    const source = readFileSync(join(import.meta.dir, "../memory/governance.ts"), "utf8");
    expect(source).toContain("export async function pruneLifecycleOutbox");
    expect(source).toContain("export async function recordQualityAudit");
    expect(source).toContain("export async function recallForContext");
    expect(source).toContain("export async function compactMemoryGovernance");
    expect(source).toContain("export async function detectMemoryConflicts");
    expect(source).toContain("export async function getMemorySourceAttribution");
    expect(source).toContain("result.trustClass !== 'retired_superseded'");
    expect(source).toContain("= ANY(${memoryIds}::uuid[])");
    expect(source).toContain("triggerType: 'feedback'");
    expect(source).toContain("triggerType: 'admin_status_change'");
    expect(source).toContain("triggerType: existing ? 'lifecycle_upsert' : 'write'");
  });
});

const databaseTest = process.env.BRAINCORE_TEST_DSN ? test : test.skip;

describe("memory governance database guards", () => {
  databaseTest("tenant-bound feedback, quality audit, and prompt audit writes", async () => {
    const dsn = process.env.BRAINCORE_TEST_DSN!;
    const sql = postgres(dsn, { max: 1 });
    const tenantA = `tenant-a-${randomUUID()}`;
    const tenantB = `tenant-b-${randomUUID()}`;
    const requestId = `audit-${randomUUID()}`;
    try {
      const [memoryA] = await sql`
        INSERT INTO preserve.memory (tenant, fingerprint, title, narrative, governance_status, trust_class)
        VALUES (${tenantA}, ${`mem-a-${randomUUID()}`}, 'Tenant A memory', 'Tenant A narrative', 'active'::preserve.memory_governance_status, 'deterministic'::preserve.memory_trust_class)
        RETURNING memory_id::text
      `;
      const [memoryB] = await sql`
        INSERT INTO preserve.memory (tenant, fingerprint, title, narrative, governance_status, trust_class)
        VALUES (${tenantB}, ${`mem-b-${randomUUID()}`}, 'Tenant B memory', 'Tenant B narrative', 'active'::preserve.memory_governance_status, 'deterministic'::preserve.memory_trust_class)
        RETURNING memory_id::text
      `;

      const wrongTenantRecorded = await recordMemoryFeedback(sql, {
        tenant: tenantA,
        memoryId: memoryB.memory_id,
        signal: "helpful",
        outcome: "wrong tenant feedback",
      });
      const wrongTenantAudit = await recordQualityAudit(sql, {
        tenant: tenantA,
        memoryId: memoryB.memory_id,
        triggerType: "feedback",
        previousQualityScore: 0.5,
        newQualityScore: 0.6,
      });
      const rightTenantRecorded = await recordMemoryFeedback(sql, {
        tenant: tenantA,
        memoryId: memoryA.memory_id,
        signal: "helpful",
        outcome: "right tenant feedback",
      });

      await auditPromptRead(sql, {
        tenant: tenantA,
        trigger: "manual",
        retrievedMemoryIds: [memoryA.memory_id, memoryB.memory_id, "not-a-uuid"],
        injectedMemoryIds: [memoryA.memory_id, memoryB.memory_id],
        omitted: [{ memoryId: memoryB.memory_id, reason: "wrong tenant" }],
        promptPackage: [
          { memoryId: memoryA.memory_id, content: "Bearer abc123token456def789ghi012jkl345" },
          { memoryId: memoryB.memory_id, content: "wrong tenant content" },
        ],
        totalTokens: 2,
        requestId,
      });

      const [counts] = await sql`
        SELECT
          (SELECT count(*)::int FROM preserve.memory_feedback_event WHERE tenant = ${tenantA} AND memory_id = ${memoryB.memory_id}) AS wrong_feedback,
          (SELECT count(*)::int FROM preserve.memory_quality_audit WHERE tenant = ${tenantA} AND memory_id = ${memoryB.memory_id}) AS wrong_audit,
          (SELECT count(*)::int FROM preserve.memory_feedback_event WHERE tenant = ${tenantA} AND memory_id = ${memoryA.memory_id}) AS right_feedback
      `;
      const [audit] = await sql`
        SELECT retrieved_memory_ids::text[] AS retrieved_memory_ids,
               injected_memory_ids::text[] AS injected_memory_ids,
               omitted,
               prompt_package
        FROM preserve.memory_context_audit
        WHERE tenant = ${tenantA}
        ORDER BY created_at DESC
        LIMIT 1
      `;

      expect(wrongTenantRecorded).toBe(false);
      expect(wrongTenantAudit).toBe(false);
      expect(rightTenantRecorded).toBe(true);
      expect(counts.wrong_feedback).toBe(0);
      expect(counts.wrong_audit).toBe(0);
      expect(counts.right_feedback).toBe(1);
      expect(audit.retrieved_memory_ids).toEqual([memoryA.memory_id]);
      expect(audit.injected_memory_ids).toEqual([memoryA.memory_id]);
      expect(audit.omitted).toEqual([]);
      expect(audit.prompt_package).toHaveLength(1);
      expect(JSON.stringify(audit.prompt_package)).toContain("Bearer [REDACTED]");
      expect(JSON.stringify(audit.prompt_package)).not.toContain("abc123token456def789ghi012jkl345");
      expect(JSON.stringify(audit.prompt_package)).not.toContain("wrong tenant content");
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
