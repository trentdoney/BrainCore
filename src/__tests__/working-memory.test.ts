import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";

import {
  addWorkingMemory,
  cleanupExpiredWorkingMemory,
  listActiveSessions,
  listWorkingMemory,
  markPromotionCandidate,
  startTaskSession,
} from "../working-memory/operations";

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

describe("working memory operations", () => {
  test("starts tenant-local sessions with default 14-day TTL", async () => {
    const { sql, calls } = makeSqlStub([
      [{
        session_id: "11111111-1111-1111-1111-111111111111",
        tenant: "tenant-a",
        session_key: "task-1",
        agent_name: "codex",
        task_title: "finish upgrade",
        status: "active",
        scope_path: "project:braincore",
        started_at: "2026-04-26T00:00:00Z",
        last_seen_at: "2026-04-26T00:00:00Z",
        ended_at: null,
        expires_at: "2026-05-10T00:00:00Z",
      }],
    ]);

    const session = await startTaskSession(sql, {
      tenant: "tenant-a",
      sessionKey: "task-1",
      agentName: "codex",
      taskTitle: "finish upgrade",
      scopePath: "project:braincore",
    });

    expect(session.sessionKey).toBe("task-1");
    expect(calls[0].text).toContain("INSERT INTO preserve.task_session");
    expect(calls[0].text).toContain("ON CONFLICT (tenant, session_key) DO UPDATE");
    expect(calls[0].text).toContain("interval '1 day'");
    expect(calls[0].values).toContain(14);
  });

  test("list-active ignores expired sessions by default", async () => {
    const { sql, calls } = makeSqlStub([[]]);
    await listActiveSessions(sql, { tenant: "tenant-a", scope: "project:braincore" });

    expect(calls[0].text).toContain("status IN ('active', 'idle')");
    expect(calls[0].text).toContain("(expires_at IS NULL OR expires_at > now())");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[0].values).toContain("project:braincore");
  });

  test("adds working memory only to active non-expired sessions", async () => {
    const { sql, calls } = makeSqlStub([
      [{
        working_memory_id: "22222222-2222-2222-2222-222222222222",
        tenant: "tenant-a",
        session_id: "11111111-1111-1111-1111-111111111111",
        memory_kind: "observation",
        content: "xrdp fix needs retest",
        promotion_status: "not_promoted",
        promotion_reason: null,
        promotion_target_kind: null,
        promotion_target_id: null,
        expires_at: "2026-05-10T00:00:00Z",
        created_at: "2026-04-26T00:00:00Z",
      }],
    ]);

    const item = await addWorkingMemory(sql, {
      tenant: "tenant-a",
      sessionKey: "task-1",
      memoryKind: "observation",
      content: "xrdp fix needs retest",
      evidenceSegmentId: "33333333-3333-3333-3333-333333333333",
    });

    expect(item?.workingMemoryId).toBe("22222222-2222-2222-2222-222222222222");
    expect(calls[0].text).toContain("FROM preserve.task_session");
    expect(calls[0].text).toContain("status IN ('active', 'idle')");
    expect(calls[0].text).toContain("(expires_at IS NULL OR expires_at > now())");
    expect(calls[0].text).toContain("INSERT INTO preserve.working_memory");
    expect(calls[0].text).toContain("ON CONFLICT (tenant, working_memory_fingerprint) DO UPDATE");
  });

  test("working memory reads exclude expired rows unless requested", async () => {
    const { sql, calls } = makeSqlStub([[]]);
    await listWorkingMemory(sql, { tenant: "tenant-a", sessionKey: "task-1" });
    await listWorkingMemory(sql, { tenant: "tenant-a", includeExpired: true });

    expect(calls[0].text).toContain("wm.expires_at > now()");
    expect(calls[0].values).toContain(false);
    expect(calls[1].values).toContain(true);
  });

  test("promotion candidate requires closed session and evidence-backed item", async () => {
    const { sql, calls } = makeSqlStub([
      [{
        working_memory_id: "22222222-2222-2222-2222-222222222222",
        tenant: "tenant-a",
        session_id: "11111111-1111-1111-1111-111111111111",
        session_key: "task-1",
        memory_kind: "decision",
        content: "promote this",
        promotion_status: "promotion_candidate",
        promotion_reason: "durable decision",
        promotion_target_kind: "memory",
        promotion_target_id: "44444444-4444-4444-4444-444444444444",
        expires_at: "2026-05-10T00:00:00Z",
        created_at: "2026-04-26T00:00:00Z",
      }],
    ]);

    const item = await markPromotionCandidate(sql, {
      tenant: "tenant-a",
      workingMemoryId: "22222222-2222-2222-2222-222222222222",
      promotionReason: "durable decision",
      promotionTargetKind: "memory",
      promotionTargetId: "44444444-4444-4444-4444-444444444444",
    });

    expect(item?.promotionStatus).toBe("promotion_candidate");
    expect(calls[0].text).toContain("ts.status IN ('completed', 'failed')");
    expect(calls[0].text).toContain("wm.expires_at > now()");
    expect(calls[0].text).toContain("wm.evidence_segment_id IS NOT NULL");
    expect(calls[0].text).toContain("promotion_target_kind");
  });

  test("cleanup marks expired unpromoted rows without deleting promoted evidence", async () => {
    const { sql, calls } = makeSqlStub([
      [{ working_memory_id: "22222222-2222-2222-2222-222222222222" }],
    ]);

    const result = await cleanupExpiredWorkingMemory(sql, { tenant: "tenant-a", limit: 10 });

    expect(result.expired).toBe(1);
    expect(calls[0].text).toContain("expires_at <= now()");
    expect(calls[0].text).toContain("promotion_status IN ('not_promoted', 'promotion_candidate', 'rejected')");
    expect(calls[0].text).not.toContain("DELETE FROM preserve.working_memory");
  });

  test("working-memory help exits before loading db config", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const cliPath = join(repoRoot, "src/cli.ts");
    const cwd = mkdtempSync(join(tmpdir(), "braincore-working-help-"));
    const env = { ...process.env, BRAINCORE_POSTGRES_DSN: "" };

    try {
      const result = spawnSync(process.execPath, [cliPath, "working-memory", "--help"], {
        cwd,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: braincore working-memory <subcommand> [options]");
      expect(result.stderr).not.toContain("Missing required environment variable");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
