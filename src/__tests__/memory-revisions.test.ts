import { describe, expect, test } from "bun:test";

process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";

import {
  findMemoryRevisionCandidates,
  insertMemoryRevisionCandidates,
  type MemoryRevisionCandidate,
} from "../consolidate/revisions";

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

describe("memory revision planning", () => {
  test("finds deterministic create/enrich/merge/demote/retire proposals", async () => {
    const { sql, calls } = makeSqlStub([
      [
        {
          memory_id: "11111111-1111-1111-1111-111111111111",
          revision_type: "enriched",
          derived_class: "rule",
          title: "Playbook: restart worker",
          old_narrative: "Restart worker.",
          new_narrative: "Restart worker.\n\nEvidence refresh: support=2, contradictions=0.",
          change_reason: "Refresh narrative with current support and contradiction counts.",
          fact_id: "22222222-2222-2222-2222-222222222222",
          episode_id: null,
        },
      ],
    ]);

    const candidates = await findMemoryRevisionCandidates(sql, {
      tenant: "tenant-a",
      scope: "project:braincore",
      limit: 25,
    });

    expect(candidates).toEqual([{
      tenant: "tenant-a",
      memoryId: "11111111-1111-1111-1111-111111111111",
      revisionType: "enriched",
      derivedClass: "rule",
      title: "Playbook: restart worker",
      oldNarrative: "Restart worker.",
      newNarrative: "Restart worker.\n\nEvidence refresh: support=2, contradictions=0.",
      changeReason: "Refresh narrative with current support and contradiction counts.",
      supportFactId: "22222222-2222-2222-2222-222222222222",
      supportEpisodeId: null,
    }]);
    expect(calls[0].text).toContain("'created'::text AS revision_type");
    expect(calls[0].text).toContain("'enriched'::text");
    expect(calls[0].text).toContain("'merged'::text");
    expect(calls[0].text).toContain("'demoted'::text");
    expect(calls[0].text).toContain("'retired'::text");
    expect(calls[0].text).toContain("m.memory_type = 'entity_summary'");
    expect(calls[0].text).toContain("m.memory_type = 'playbook'");
    expect(calls[0].text).toContain("m.memory_type IN ('pattern', 'heuristic')");
    expect(calls[0].text).toContain("'experience'");
    expect(calls[0].text).toContain("FROM preserve.memory m");
    expect(calls[0].text).not.toContain("INSERT INTO preserve.fact");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[0].values).toContain("project:braincore");
  });

  test("inserts revision proposals and support rows without modifying facts", async () => {
    const candidate: MemoryRevisionCandidate = {
      tenant: "tenant-a",
      memoryId: "11111111-1111-1111-1111-111111111111",
      revisionType: "demoted",
      derivedClass: "entity_summary",
      title: "Old memory",
      oldNarrative: "old",
      newNarrative: "old",
      changeReason: "Published memory has stale or missing support; demote to draft for review.",
      supportFactId: "22222222-2222-2222-2222-222222222222",
      supportEpisodeId: null,
    };
    const stub = makeSqlStub([
      [{ revision_id: "33333333-3333-3333-3333-333333333333" }],
      [{ revision_support_id: "44444444-4444-4444-4444-444444444444" }],
    ]);

    const result = await insertMemoryRevisionCandidates([candidate], stub.sql);

    expect(result).toEqual({ proposed: 1, inserted: 1, supportRows: 1 });
    expect(stub.beginCalled).toBe(true);
    expect(stub.calls[0].text).toContain("INSERT INTO preserve.memory_revision");
    expect(stub.calls[0].text).toContain("WHERE NOT EXISTS");
    expect(stub.calls[1].text).toContain("INSERT INTO preserve.memory_revision_support");
    expect(stub.calls.map((call) => call.text).join("\n")).not.toContain("INSERT INTO preserve.fact");
  });
});
