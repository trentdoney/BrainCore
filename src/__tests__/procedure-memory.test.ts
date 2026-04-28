import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";

import {
  extractProcedureSteps,
  findProcedureCandidates,
  insertProcedureCandidates,
  procedureFingerprint,
  type ProcedureCandidate,
} from "../consolidate/procedures";
import {
  findFailedRemediationSteps,
  findNextProcedureSteps,
  findTriedProcedureSteps,
} from "../procedure/operational";
import { searchProcedures } from "../procedure/search";

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

describe("procedure memory consolidation", () => {
  test("extracts ordered steps from common procedure shapes", () => {
    expect(extractProcedureSteps("1. Stop worker\n2. Clear queue\n3. Restart worker")).toEqual([
      { action: "Stop worker", expectedResult: null },
      { action: "Clear queue", expectedResult: null },
      { action: "Restart worker", expectedResult: null },
    ]);
    expect(extractProcedureSteps({ steps: [{ action: "Run migration", expected_result: "schema updated" }] })).toEqual([
      { action: "Run migration", expectedResult: "schema updated" },
    ]);
  });

  test("fingerprints are tenant and scope aware", () => {
    const first = procedureFingerprint({
      tenant: "tenant-a",
      sourceFactId: "11111111-1111-1111-1111-111111111111",
      title: "Procedure: restart service",
      scopePath: "project:braincore",
    });
    const same = procedureFingerprint({
      tenant: "tenant-a",
      sourceFactId: "11111111-1111-1111-1111-111111111111",
      title: "procedure: restart service",
      scopePath: "project:braincore",
    });
    const otherTenant = procedureFingerprint({
      tenant: "tenant-b",
      sourceFactId: "11111111-1111-1111-1111-111111111111",
      title: "Procedure: restart service",
      scopePath: "project:braincore",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(same);
    expect(first).not.toBe(otherTenant);
  });

  test("finds grounded tenant-local procedure candidates", async () => {
    const { sql, calls } = makeSqlStub([
      [{
        fact_id: "11111111-1111-1111-1111-111111111111",
        episode_id: "22222222-2222-2222-2222-222222222222",
        scope_entity_id: "33333333-3333-3333-3333-333333333333",
        project_entity_id: "44444444-4444-4444-4444-444444444444",
        subject_name: "worker",
        predicate: "fixed_by",
        object_value: "1. Stop worker\n2. Clear queue\n3. Restart worker",
        confidence: 0.91,
        assertion_class: "human_curated",
        created_run_id: "55555555-5555-5555-5555-555555555555",
        scope_path: "project:braincore",
        evidence_segment_id: "66666666-6666-6666-6666-666666666666",
      }],
    ]);

    const candidates = await findProcedureCandidates(sql, {
      tenant: "tenant-a",
      scope: "project:braincore",
      limit: 25,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      tenant: "tenant-a",
      sourceFactId: "11111111-1111-1111-1111-111111111111",
      sourceEpisodeId: "22222222-2222-2222-2222-222222222222",
      scopeEntityId: "33333333-3333-3333-3333-333333333333",
      evidenceSegmentId: "66666666-6666-6666-6666-666666666666",
      confidence: 0.91,
      assertionClass: "human_curated",
      subjectName: "worker",
    });
    expect(candidates[0].steps).toHaveLength(3);
    expect(candidates[0].procedureFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[0].text).toContain("JOIN preserve.entity subject");
    expect(calls[0].text).toContain("subject.tenant = ?");
    expect(calls[0].text).toContain("f.tenant = ?");
    expect(calls[0].text).toContain("evidence.segment_id IS NOT NULL");
    expect(calls[0].text).toContain("LEFT JOIN preserve.procedure existing");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[0].values).toContain("project:braincore");
  });

  test("inserts procedures and steps idempotently", async () => {
    const candidate: ProcedureCandidate = {
      tenant: "tenant-a",
      procedureFingerprint: "a".repeat(64),
      title: "Procedure: worker fixed_by restart",
      summary: "restart worker",
      sourceFactId: "11111111-1111-1111-1111-111111111111",
      sourceMemoryId: null,
      sourceEpisodeId: "22222222-2222-2222-2222-222222222222",
      scopeEntityId: "33333333-3333-3333-3333-333333333333",
      projectEntityId: null,
      evidenceSegmentId: "66666666-6666-6666-6666-666666666666",
      assertionClass: "deterministic",
      confidence: 1,
      lifecycleState: "draft",
      scopePath: "project:braincore",
      procedureJson: { source: "fact" },
      createdRunId: "55555555-5555-5555-5555-555555555555",
      subjectName: "worker",
      predicate: "fixed_by",
      steps: [{
        stepIndex: 1,
        action: "Restart worker",
        expectedResult: null,
        sourceFactId: "11111111-1111-1111-1111-111111111111",
        evidenceSegmentId: "66666666-6666-6666-6666-666666666666",
        assertionClass: "deterministic",
        confidence: 1,
        scopePath: "project:braincore",
        stepJson: { action: "Restart worker" },
        createdRunId: "55555555-5555-5555-5555-555555555555",
      }],
    };
    const stub = makeSqlStub([
      [{ procedure_id: "77777777-7777-7777-7777-777777777777" }],
      [{ procedure_step_id: "88888888-8888-8888-8888-888888888888" }],
    ]);

    const result = await insertProcedureCandidates([candidate], stub.sql);

    expect(result).toEqual({ proposed: 1, inserted: 1, insertedSteps: 1 });
    expect(stub.beginCalled).toBe(true);
    expect(stub.calls[0].text).toContain("INSERT INTO preserve.procedure");
    expect(stub.calls[0].text).toContain("ON CONFLICT (tenant, procedure_fingerprint) DO NOTHING");
    expect(stub.calls[1].text).toContain("INSERT INTO preserve.procedure_step");
    expect(stub.calls[1].text).toContain("ON CONFLICT (procedure_id, step_index) DO NOTHING");
  });
});

describe("procedure search", () => {
  test("searches tenant-local non-retired procedures with scope filtering", async () => {
    const { sql, calls } = makeSqlStub([
      [{
        procedure_id: "77777777-7777-7777-7777-777777777777",
        title: "Procedure: restart worker",
        summary: "restart worker safely",
        confidence: 0.84,
        scope_path: "project:braincore",
        source_fact_id: "11111111-1111-1111-1111-111111111111",
        steps: [{ stepIndex: 1, action: "Restart worker", expectedResult: null }],
      }],
    ]);

    const results = await searchProcedures(sql, {
      tenant: "tenant-a",
      query: "restart worker",
      scope: "project:braincore",
      limit: 10,
    });

    expect(results).toEqual([{
      procedureId: "77777777-7777-7777-7777-777777777777",
      title: "Procedure: restart worker",
      summary: "restart worker safely",
      confidence: 0.84,
      scopePath: "project:braincore",
      sourceFactId: "11111111-1111-1111-1111-111111111111",
      steps: [{ stepIndex: 1, action: "Restart worker", expectedResult: null }],
    }]);
    expect(calls[0].text).toContain("FROM preserve.procedure p");
    expect(calls[0].text).toContain("p.tenant = ?");
    expect(calls[0].text).toContain("p.lifecycle_state != 'retired'");
    expect(calls[0].text).toContain("ps.tenant = ?");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[0].values).toContain("restart worker");
    expect(calls[0].values).toContain("project:braincore");
  });

  test("procedure help exits before loading db config", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const cliPath = join(repoRoot, "src/cli.ts");
    const cwd = mkdtempSync(join(tmpdir(), "braincore-procedure-help-"));
    const env = { ...process.env, BRAINCORE_POSTGRES_DSN: "" };

    try {
      const result = spawnSync(process.execPath, [cliPath, "procedure", "--help"], {
        cwd,
        env,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: braincore procedure <subcommand> [options]");
      expect(result.stderr).not.toContain("Missing required environment variable");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("procedure operational tools", () => {
  const row = {
    procedure_id: "77777777-7777-7777-7777-777777777777",
    procedure_title: "Procedure: restart worker",
    procedure_summary: "restart worker safely",
    scope_path: "project:braincore",
    procedure_source_fact_id: "11111111-1111-1111-1111-111111111111",
    procedure_evidence_segment_id: "22222222-2222-2222-2222-222222222222",
    episode_outcome: "resolved",
    step_id: "33333333-3333-3333-3333-333333333333",
    step_index: 2,
    action: "Restart worker",
    expected_result: "worker healthy",
    step_source_fact_id: "44444444-4444-4444-4444-444444444444",
    step_evidence_segment_id: "55555555-5555-5555-5555-555555555555",
    confidence: 0.84,
  };

  test("next-step returns the first incomplete evidence-backed step", async () => {
    const { sql, calls } = makeSqlStub([[row]]);

    const results = await findNextProcedureSteps(sql, {
      tenant: "tenant-a",
      query: "restart worker",
      scope: "project:braincore",
      completedSteps: 1,
      limit: 5,
    });

    expect(results[0]).toMatchObject({
      procedureId: "77777777-7777-7777-7777-777777777777",
      stepIndex: 2,
      action: "Restart worker",
      stepEvidenceSegmentId: "55555555-5555-5555-5555-555555555555",
      episodeOutcome: "resolved",
    });
    expect(calls[0].text).toContain("JOIN LATERAL");
    expect(calls[0].text).toContain("ps.step_index > ?");
    expect(calls[0].text).toContain("p.tenant = ?");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[0].values).toContain(1);
  });

  test("what-did-we-try returns prior tried steps with outcomes", async () => {
    const { sql, calls } = makeSqlStub([[row]]);

    const results = await findTriedProcedureSteps(sql, {
      tenant: "tenant-a",
      query: "restart worker",
      scope: "project:braincore",
      limit: 5,
    });

    expect(results[0].expectedResult).toBe("worker healthy");
    expect(results[0].procedureEvidenceSegmentId).toBe("22222222-2222-2222-2222-222222222222");
    expect(calls[0].text).toContain("JOIN preserve.procedure_step ps");
    expect(calls[0].text).toContain("LEFT JOIN preserve.episode ep");
    expect(calls[0].text).toContain("ps.action ILIKE");
  });

  test("failed-remediations filters for failure outcome signals", async () => {
    const { sql, calls } = makeSqlStub([[{ ...row, episode_outcome: "failed" }]]);

    const results = await findFailedRemediationSteps(sql, {
      tenant: "tenant-a",
      query: "restart worker",
      scope: "project:braincore",
      limit: 5,
    });

    expect(results[0].episodeOutcome).toBe("failed");
    expect(calls[0].text).toContain("lower(COALESCE(ep.outcome, '')) ~");
    expect(calls[0].text).toContain("lower(COALESCE(ps.expected_result, '')) ~");
  });
});
