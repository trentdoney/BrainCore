import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";
process.env.BRAINCORE_TENANT ??= "test-tenant";

import {
  assessMemoryHealth,
  collectMemoryUsage,
  decideMemoryHealth,
  findMemoryRetentionReviewCandidates,
  insertMemoryRetentionReviewCandidates,
  memoryHealthFingerprint,
  memoryUsageFingerprint,
  recordMemoryUsage,
  type MemoryRetentionReviewCandidate,
} from "../reflection/usage";

interface SqlCall {
  text: string;
  values: unknown[];
}

function makeSqlStub(responses: unknown[][]) {
  const calls: SqlCall[] = [];
  let beginCalled = false;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(responses.shift() ?? []);
  }) as any;
  sql.begin = async (fn: (tx: typeof sql) => Promise<void>) => {
    beginCalled = true;
    return fn(sql);
  };
  sql.json = (value: unknown) => value;
  return { sql, calls, get beginCalled() { return beginCalled; } };
}

describe("reflection memory usage", () => {
  test("usage fingerprints are tenant, scope, source, and measurement aware", () => {
    const measuredAt = new Date("2026-04-26T12:00:00.000Z");
    const first = memoryUsageFingerprint({
      tenant: "tenant-a",
      scopePath: "project:braincore",
      source: "nightly",
      measuredAt,
    });
    const same = memoryUsageFingerprint({
      tenant: "TENANT-A",
      scopePath: " project:braincore ",
      source: "NIGHTLY",
      measuredAt,
    });
    const otherScope = memoryUsageFingerprint({
      tenant: "tenant-a",
      scopePath: "project:other",
      source: "nightly",
      measuredAt,
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(same);
    expect(first).not.toBe(otherScope);
  });

  test("collects tenant-local scope-filtered usage metrics", async () => {
    const measuredAt = new Date("2026-04-26T12:00:00.000Z");
    const { sql, calls } = makeSqlStub([
      [{
        total_memory_count: "10",
        published_count: "6",
        draft_count: "3",
        retired_count: "1",
        unsupported_count: "2",
        stale_count: "1",
        contradiction_count: "1",
        avg_confidence: "0.82",
        byte_estimate: "4096",
      }],
    ]);

    const usage = await collectMemoryUsage(sql, {
      tenant: "tenant-a",
      scope: "project:braincore",
      source: "nightly",
      measuredAt,
    });

    expect(usage).toMatchObject({
      tenant: "tenant-a",
      scopePath: "project:braincore",
      source: "nightly",
      totalMemoryCount: 10,
      publishedCount: 6,
      draftCount: 3,
      retiredCount: 1,
      unsupportedCount: 2,
      staleCount: 1,
      contradictionCount: 1,
      avgConfidence: 0.82,
      byteEstimate: 4096,
      metrics: {
        staleAfterDays: 180,
        unsupportedRatio: 0.2,
        staleRatio: 0.1,
        contradictionRatio: 0.1,
      },
    });
    expect(calls[0].text).toContain("FROM preserve.memory m");
    expect(calls[0].text).toContain("m.tenant = ?");
    expect(calls[0].text).toContain("COALESCE(m.scope_path, '') LIKE (? || '%')");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[0].values).toContain("project:braincore");
  });

  test("records usage idempotently in existing schema", async () => {
    const { sql, calls } = makeSqlStub([
      [{
        total_memory_count: "1",
        published_count: "1",
        draft_count: "0",
        retired_count: "0",
        unsupported_count: "0",
        stale_count: "0",
        contradiction_count: "0",
        avg_confidence: "0.91",
        byte_estimate: "128",
      }],
      [{ usage_id: "11111111-1111-1111-1111-111111111111", inserted: true }],
    ]);

    const result = await recordMemoryUsage(sql, {
      tenant: "tenant-a",
      measuredAt: new Date("2026-04-26T12:00:00.000Z"),
    });

    expect(result.inserted).toBe(true);
    expect(result.usage.usageId).toBe("11111111-1111-1111-1111-111111111111");
    expect(calls[1].text).toContain("INSERT INTO preserve.memory_usage");
    expect(calls[1].text).toContain("ON CONFLICT (tenant, usage_fingerprint) DO UPDATE");
    expect(calls[1].values).toContain("tenant-a");
  });

  test("assesses health with deterministic usage evidence", async () => {
    const { sql, calls } = makeSqlStub([
      [{
        total_memory_count: "10",
        published_count: "6",
        draft_count: "3",
        retired_count: "1",
        unsupported_count: "2",
        stale_count: "1",
        contradiction_count: "0",
        avg_confidence: "0.75",
        byte_estimate: "1024",
      }],
      [{ usage_id: "11111111-1111-1111-1111-111111111111", inserted: true }],
      [{ health_id: "22222222-2222-2222-2222-222222222222", inserted: true }],
      [],
    ]);

    const result = await assessMemoryHealth(sql, {
      tenant: "tenant-a",
      scope: "project:braincore",
      source: "nightly",
    });

    expect(result.inserted).toBe(true);
    expect(result.health).toMatchObject({
      healthId: "22222222-2222-2222-2222-222222222222",
      tenant: "tenant-a",
      usageId: "11111111-1111-1111-1111-111111111111",
      scopePath: "project:braincore",
      status: "degraded",
    });
    expect(sql.begin).toBeDefined();
    expect(calls[2].text).toContain("INSERT INTO preserve.memory_health");
    expect(calls[2].text).toContain("ON CONFLICT (tenant, health_fingerprint) DO UPDATE");
    expect(calls[2].values).toContain("tenant-a");
    expect(calls[2].values).toContain("11111111-1111-1111-1111-111111111111");
    expect(calls[3].text).toContain("INSERT INTO preserve.memory_health_evidence");
    expect(calls[3].text).toContain("usage_id");
    expect(calls[3].values).toContain("22222222-2222-2222-2222-222222222222");
    expect(calls[3].values).toContain("11111111-1111-1111-1111-111111111111");
  });

  test("decisions explain retention risk and stay usage-id scoped", () => {
    const usage = {
      tenant: "tenant-a",
      usageId: "11111111-1111-1111-1111-111111111111",
      scopePath: "project:braincore",
      totalMemoryCount: 20,
      unsupportedCount: 0,
      staleCount: 6,
      contradictionCount: 0,
      metrics: {
        staleAfterDays: 180,
        unsupportedRatio: 0,
        staleRatio: 0.3,
        contradictionRatio: 0,
      },
    };

    const decision = decideMemoryHealth({
      usage,
      assessedAt: new Date("2026-04-26T12:00:00.000Z"),
    });

    expect(decision.status).toBe("degraded");
    expect(decision.riskScore).toBeGreaterThan(0);
    expect(decision.assessmentText).toContain("6/20 stale");
    expect(decision.recommendations).toContain("Refresh published memories without support in the last 180 days.");
    expect(decision.healthFingerprint).toBe(memoryHealthFingerprint({
      tenant: usage.tenant,
      usageId: usage.usageId,
      scopePath: usage.scopePath,
    }));
  });

  test("finds health-driven retention review candidates without updating memories", async () => {
    const { sql, calls } = makeSqlStub([
      [{
        memory_id: "33333333-3333-3333-3333-333333333333",
        title: "Old playbook",
        scope_path: "project:braincore",
        proposal_type: "demote",
        reason: "Adaptive retention review: published memory is stale; review demotion to draft.",
        risk_score: "0.7",
      }],
    ]);

    const candidates = await findMemoryRetentionReviewCandidates(sql, {
      tenant: "tenant-a",
      scope: "project:braincore",
      limit: 25,
    });

    expect(candidates).toEqual([{
      tenant: "tenant-a",
      memoryId: "33333333-3333-3333-3333-333333333333",
      title: "Old playbook",
      scopePath: "project:braincore",
      proposalType: "demote",
      reason: "Adaptive retention review: published memory is stale; review demotion to draft.",
      riskScore: 0.7,
    }]);
    expect(calls[0].text).toContain("FROM preserve.memory m");
    expect(calls[0].text).toContain("LEFT JOIN latest_health");
    expect(calls[0].text).toContain("preserve.review_queue");
    expect(calls[0].text).not.toContain("UPDATE preserve.memory");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[0].values).toContain("project:braincore");
  });

  test("inserts retention review rows without lifecycle changes", async () => {
    const candidate: MemoryRetentionReviewCandidate = {
      tenant: "tenant-a",
      memoryId: "33333333-3333-3333-3333-333333333333",
      title: "Old playbook",
      scopePath: "project:braincore",
      proposalType: "refresh",
      reason: "Adaptive retention review: active memory lacks evidence support; refresh or relink evidence.",
      riskScore: 0.5,
    };
    const stub = makeSqlStub([
      [{ review_id: "44444444-4444-4444-4444-444444444444" }],
    ]);

    const result = await insertMemoryRetentionReviewCandidates([candidate], stub.sql);

    expect(result).toEqual({ proposed: 1, inserted: 1 });
    expect(stub.beginCalled).toBe(true);
    expect(stub.calls[0].text).toContain("INSERT INTO preserve.review_queue");
    expect(stub.calls[0].text).toContain("WHERE NOT EXISTS");
    expect(stub.calls[0].text).not.toContain("UPDATE preserve.memory");
    expect(stub.calls[0].values).toContain("33333333-3333-3333-3333-333333333333");
    expect(stub.calls[0].values).toContain(candidate.reason);
  });

  test("reflection help exits before loading db config", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const cliPath = join(repoRoot, "src/cli.ts");
    const cwd = mkdtempSync(join(tmpdir(), "braincore-reflection-help-"));
    const env = { ...process.env, BRAINCORE_POSTGRES_DSN: "" };

    try {
      const result = spawnSync(process.execPath, [cliPath, "reflection", "--help"], {
        cwd,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: braincore reflection <subcommand> [options]");
      expect(result.stdout).toContain("retention-review");
      expect(result.stderr).not.toContain("Missing required environment variable");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
