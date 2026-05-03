import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";

import {
  EvidenceBoundaryError,
  assertAdminStatusMutationAllowed,
  assertFeedbackMutationAllowed,
  assertLifecycleEventCanCreateTarget,
} from "../lifecycle/evidence-boundary";
import {
  LifecycleTargetNotFoundError,
  enqueueLifecycleEvent,
  listLifecycleEvents,
  recordContextRecallAudit,
  backfillLifecycleIntelligence,
} from "../lifecycle/operations";

interface SqlCall {
  text: string;
  values: unknown[];
}

function makeSqlStub(responses: unknown[][]) {
  const calls: SqlCall[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(responses.shift() ?? []);
  }) as any;
  sql.json = (value: unknown) => value;
  return { sql, calls };
}

describe("lifecycle evidence boundary", () => {
  test("blocks feedback from mutating native truth tables", () => {
    expect(() => assertFeedbackMutationAllowed({
      targetKind: "memory",
      signal: "user_corrected",
      requestedNativeMutation: true,
    })).toThrow(EvidenceBoundaryError);
  });

  test("rejects lifecycle events for missing native targets", async () => {
    const { sql, calls } = makeSqlStub([[]]);

    await expect(enqueueLifecycleEvent(sql, {
      tenant: "tenant-a",
      eventId: "evt-missing",
      eventType: "memory_retrieved",
      sourceService: "agentfanout",
      targetKind: "memory",
      targetId: "22222222-2222-2222-2222-222222222222",
    })).rejects.toThrow(LifecycleTargetNotFoundError);

    expect(calls[0].text).toContain("FROM preserve.memory");
    expect(calls).toHaveLength(1);
  });

  test("wires produced target evidence-boundary checks at enqueue", async () => {
    const { sql, calls } = makeSqlStub([]);

    await expect(enqueueLifecycleEvent(sql, {
      tenant: "tenant-a",
      eventId: "evt-created",
      eventType: "memory_written",
      sourceService: "agentfanout",
      payload: { producedTargetKind: "memory" },
      evidenceRefs: [],
    })).rejects.toThrow("Lifecycle events cannot directly create durable memories");

    expect(calls).toHaveLength(0);
  });

  test("allows durable fact creation only with approved segment evidence", () => {
    expect(() => assertLifecycleEventCanCreateTarget({
      eventType: "fact_inserted",
      targetKind: "fact",
      evidenceRefs: [{ segment_id: "33333333-3333-3333-3333-333333333333" }],
    })).not.toThrow();

    expect(() => assertLifecycleEventCanCreateTarget({
      eventType: "memory_written",
      targetKind: "fact",
      evidenceRefs: [],
    })).toThrow(EvidenceBoundaryError);
  });

  test("blocks admin requests that try to change native rows", () => {
    expect(() => assertAdminStatusMutationAllowed({
      targetKind: "fact",
      requestedNativeMutation: true,
    })).toThrow(EvidenceBoundaryError);
  });
});

describe("lifecycle operations", () => {
  test("enqueues idempotent events with tenant-local target pairing", async () => {
    const { sql, calls } = makeSqlStub([
      [{ "?column?": 1 }],
      [{
        outbox_id: "11111111-1111-1111-1111-111111111111",
        tenant: "tenant-a",
        event_id: "evt-1",
        event_type: "memory_retrieved",
        source_service: "agentfanout",
        status: "pending",
        target_kind: "memory",
        target_id: "22222222-2222-2222-2222-222222222222",
        attempt_count: 0,
        received_at: "2026-05-02T00:00:00Z",
      }],
    ]);

    const event = await enqueueLifecycleEvent(sql, {
      tenant: "tenant-a",
      eventId: "evt-1",
      eventType: "memory_retrieved",
      sourceService: "agentfanout",
      targetKind: "memory",
      targetId: "22222222-2222-2222-2222-222222222222",
      payload: { cues: ["release gate"] },
    });

    expect(event.outboxId).toBe("11111111-1111-1111-1111-111111111111");
    expect(calls[0].text).toContain("FROM preserve.memory");
    expect(calls[1].text).toContain("INSERT INTO preserve.lifecycle_outbox");
    expect(calls[1].text).toContain("ON CONFLICT (tenant, idempotency_key) DO UPDATE");
    expect(calls[1].values).toContain("agentfanout:evt-1");
  });

  test("lists outbox events without touching native memory tables", async () => {
    const { sql, calls } = makeSqlStub([[]]);
    await listLifecycleEvents(sql, { tenant: "tenant-a", status: "failed" });

    expect(calls[0].text).toContain("FROM preserve.lifecycle_outbox");
    expect(calls[0].text).not.toContain("FROM preserve.memory ");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[0].values).toContain("failed");
  });

  test("records context recall audit packages", async () => {
    const { sql, calls } = makeSqlStub([
      [{ context_audit_id: "44444444-4444-4444-4444-444444444444" }],
    ]);

    const result = await recordContextRecallAudit(sql, {
      tenant: "tenant-a",
      trigger: "pre_model_call",
      mode: "shadow",
      goal: "finish upgrade",
      maxTokens: 1200,
    });

    expect(result.contextAuditId).toBe("44444444-4444-4444-4444-444444444444");
    expect(calls[0].text).toContain("INSERT INTO preserve.context_recall_audit");
    expect(calls[0].values).toContain("pre_model_call");
    expect(calls[0].values).toContain("shadow");
  });

  test("backfill uses structured SQL paths instead of unsafe dynamic identifiers", async () => {
    const { sql, calls } = makeSqlStub([[{ intelligence_id: "55555555-5555-5555-5555-555555555555" }]]);

    const result = await backfillLifecycleIntelligence(sql, {
      tenant: "tenant-a",
      targetKind: "memory",
      limit: 10,
    });

    expect(result.inserted).toBe(1);
    expect(calls[0].text).toContain("FROM preserve.memory");
    expect(calls[0].text).toContain("memory_id AS target_id");
    expect(typeof sql.unsafe).toBe("undefined");
  });

  test("lifecycle help exits before loading db config", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const cliPath = join(repoRoot, "src/cli.ts");
    const cwd = mkdtempSync(join(tmpdir(), "braincore-lifecycle-help-"));
    const env = { ...process.env, BRAINCORE_POSTGRES_DSN: "" };

    try {
      const result = spawnSync(process.execPath, [cliPath, "lifecycle", "--help"], {
        cwd,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: braincore lifecycle <subcommand> [options]");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
