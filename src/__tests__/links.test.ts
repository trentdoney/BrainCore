import { describe, expect, test } from "bun:test";

process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";

import {
  findLinkCandidates,
  insertLinkCandidates,
  type LinkCandidate,
} from "../consolidate/links";

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
  return { sql, calls, get beginCalled() { return beginCalled; } };
}

describe("memory graph link consolidation", () => {
  test("finds high-trust fact-to-memory edge candidates with tenant and scope filters", async () => {
    const { sql, calls } = makeSqlStub([
      [{
        fact_id: "11111111-1111-1111-1111-111111111111",
        memory_id: "22222222-2222-2222-2222-222222222222",
        support_type: "supporting",
        edge_type: "fixes",
        confidence: 0.91,
        assertion_class: "human_curated",
        created_run_id: "33333333-3333-3333-3333-333333333333",
        scope_path: "project:braincore",
        fact_title: "fixed_by",
        memory_title: "BrainCore remediation",
        evidence_segment_id: "44444444-4444-4444-4444-444444444444",
      }],
    ]);

    const candidates = await findLinkCandidates(sql, {
      tenant: "tenant-a",
      scope: "project:braincore",
      memoryType: "playbook",
      limit: 50,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      tenant: "tenant-a",
      sourceType: "fact",
      sourceId: "11111111-1111-1111-1111-111111111111",
      targetType: "memory",
      targetId: "22222222-2222-2222-2222-222222222222",
      edgeType: "fixes",
      confidence: 0.91,
      assertionClass: "human_curated",
      scopePath: "project:braincore",
    });
    expect(candidates[0].edgeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[0].text).toContain("JOIN preserve.memory m");
    expect(calls[0].text).toContain("m.tenant = ?");
    expect(calls[0].text).toContain("m.memory_type::text");
    expect(calls[0].text).toContain("JOIN preserve.fact f");
    expect(calls[0].text).toContain("JOIN LATERAL");
    expect(calls[0].text).toContain("f.tenant = ?");
    expect(calls[0].text).toContain("f.assertion_class IN");
    expect(calls[0].text).toContain("f.fact_kind IN");
    expect(calls[0].text).not.toContain("'lesson'");
    expect(calls[0].text).toContain("WHEN fact_kind = 'cause'");
    expect(calls[0].text).toContain("THEN 'fixes'");
    expect(calls[0].text).toContain("THEN 'mitigates'");
    expect(calls[0].text).toContain("THEN 'supersedes'");
    expect(calls[0].text).toContain("THEN 'duplicates'");
    expect(calls[0].text).toContain("THEN 'depends_on'");
    expect(calls[0].text).toContain("LEFT JOIN preserve.memory_edge existing");
    expect(calls[0].text).toContain("existing.edge_type = typed_candidates.edge_type");
    expect(calls[0].text).toContain("typed_candidates.edge_type != 'supports'");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[0].values).toContain("project:braincore");
    expect(calls[0].values).toContain("playbook");
  });

  test("inserts candidates idempotently through memory_edge fingerprint conflict", async () => {
    const candidate: LinkCandidate = {
      tenant: "tenant-a",
      sourceType: "fact",
      sourceId: "11111111-1111-1111-1111-111111111111",
      targetType: "memory",
      targetId: "22222222-2222-2222-2222-222222222222",
      edgeType: "contradicts",
      edgeFingerprint: "a".repeat(64),
      confidence: 0.73,
      assertionClass: "deterministic",
      evidenceSegmentId: "44444444-4444-4444-4444-444444444444",
      createdRunId: null,
      scopePath: "project:braincore",
      factTitle: "changed",
      memoryTitle: "Old memory",
    };
    const stub = makeSqlStub([
      [{ edge_id: "55555555-5555-5555-5555-555555555555" }],
      [{ edge_evidence_id: "66666666-6666-6666-6666-666666666666" }],
    ]);

    const result = await insertLinkCandidates([candidate], stub.sql);

    expect(result).toEqual({ proposed: 1, inserted: 1, evidenceRows: 1 });
    expect(stub.beginCalled).toBe(true);
    expect(stub.calls[0].text).toContain("INSERT INTO preserve.memory_edge");
    expect(stub.calls[0].text).toContain("ON CONFLICT (tenant, edge_fingerprint) DO NOTHING");
    expect(stub.calls[1].text).toContain("INSERT INTO preserve.memory_edge_evidence");
    expect(stub.calls[0].values).toContain("tenant-a");
    expect(stub.calls[0].values).toContain("contradicts");
  });
});
