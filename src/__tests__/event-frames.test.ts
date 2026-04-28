import { describe, expect, test } from "bun:test";

process.env.BRAINCORE_POSTGRES_DSN ??= "postgres://test:test@localhost:5432/test";

import {
  findEventFrameCandidates,
  insertEventFrameCandidates,
  type EventFrameCandidate,
} from "../consolidate/event-frames";

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

describe("event frame consolidation", () => {
  test("finds grounded tenant-local event-frame candidates", async () => {
    const { sql, calls } = makeSqlStub([
      [{
        fact_id: "11111111-1111-1111-1111-111111111111",
        episode_id: "22222222-2222-2222-2222-222222222222",
        event_type: "remediation",
        action: "fixed_by",
        actor_entity_id: "33333333-3333-3333-3333-333333333333",
        subject_name: "xrdp",
        target_entity_id: null,
        target_name: null,
        object_value: "restart xrdp after clearing stale session",
        time_start: "2026-04-26T00:00:00.000Z",
        time_end: null,
        location_entity_id: null,
        cause_fact_id: null,
        effect_fact_id: null,
        confidence: 0.89,
        assertion_class: "human_curated",
        created_run_id: "44444444-4444-4444-4444-444444444444",
        scope_path: "project:braincore",
        evidence_segment_id: "55555555-5555-5555-5555-555555555555",
      }],
    ]);

    const candidates = await findEventFrameCandidates(sql, {
      tenant: "tenant-a",
      scope: "project:braincore",
      eventType: "remediation",
      limit: 25,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      tenant: "tenant-a",
      episodeId: "22222222-2222-2222-2222-222222222222",
      sourceFactId: "11111111-1111-1111-1111-111111111111",
      eventType: "remediation",
      action: "fixed_by",
      actorEntityId: "33333333-3333-3333-3333-333333333333",
      confidence: 0.89,
      assertionClass: "human_curated",
      evidenceSegmentId: "55555555-5555-5555-5555-555555555555",
      outcome: "restart xrdp after clearing stale session",
    });
    expect(candidates[0].frameFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[0].text).toContain("JOIN preserve.episode ep");
    expect(calls[0].text).toContain("ep.tenant = ?");
    expect(calls[0].text).toContain("f.tenant = ?");
    expect(calls[0].text).toContain("f.assertion_class IN");
    expect(calls[0].text).toContain("evidence.segment_id IS NOT NULL");
    expect(calls[0].text).toContain("LEFT JOIN preserve.event_frame existing");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[0].values).toContain("project:braincore");
    expect(calls[0].values).toContain("remediation");
  });

  test("inserts event-frame candidates idempotently", async () => {
    const candidate: EventFrameCandidate = {
      tenant: "tenant-a",
      frameFingerprint: "a".repeat(64),
      episodeId: "22222222-2222-2222-2222-222222222222",
      sourceFactId: "11111111-1111-1111-1111-111111111111",
      eventType: "cause",
      actorEntityId: "33333333-3333-3333-3333-333333333333",
      action: "caused_by",
      targetEntityId: null,
      objectValue: { summary: "bad config" },
      timeStart: null,
      timeEnd: null,
      locationEntityId: null,
      causeFactId: "11111111-1111-1111-1111-111111111111",
      effectFactId: null,
      outcome: null,
      confidence: 0.77,
      assertionClass: "deterministic",
      evidenceSegmentId: "55555555-5555-5555-5555-555555555555",
      scopePath: "project:braincore",
      createdRunId: "44444444-4444-4444-4444-444444444444",
      subjectName: "service-a",
      targetName: null,
    };
    const stub = makeSqlStub([
      [{ event_frame_id: "66666666-6666-6666-6666-666666666666" }],
    ]);

    const result = await insertEventFrameCandidates([candidate], stub.sql);

    expect(result).toEqual({ proposed: 1, inserted: 1 });
    expect(stub.beginCalled).toBe(true);
    expect(stub.calls[0].text).toContain("INSERT INTO preserve.event_frame");
    expect(stub.calls[0].text).toContain("ON CONFLICT (tenant, frame_fingerprint) DO NOTHING");
    expect(stub.calls[0].values).toContain("tenant-a");
    expect(stub.calls[0].values).toContain("cause");
  });
});
