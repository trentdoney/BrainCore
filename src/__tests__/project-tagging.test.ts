import { describe, expect, test } from "bun:test";
import {
  backfillMemoryProjectTagsWithDb,
  type ProjectTaggingSqlLike,
} from "../project/tagging";

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
  }) as ProjectTaggingSqlLike;
  sql.begin = async (fn) => {
    beginCalled = true;
    return fn(sql);
  };
  return { sql, calls, get beginCalled() { return beginCalled; } };
}

describe("backfillMemoryProjectTagsWithDb", () => {
  test("updates memory projects only when support resolves to one tenant-local project", async () => {
    const stub = makeSqlStub([
      [],
      [
        { memory_id: "11111111-1111-1111-1111-111111111111" },
        { memory_id: "22222222-2222-2222-2222-222222222222" },
      ],
      [{ n: "2" }],
    ]);

    const result = await backfillMemoryProjectTagsWithDb(stub.sql, "tenant-a");

    expect(result).toEqual({ memoriesTagged: 2, unresolvedMemories: 2 });
    expect(stub.beginCalled).toBe(true);
    const { calls } = stub;
    expect(calls).toHaveLength(3);

    expect(calls[0].text).toContain("UPDATE preserve.memory");
    expect(calls[0].text).toContain("WHERE tenant = ?");
    expect(calls[0].values).toEqual(["tenant-a"]);

    const updateSql = calls[1].text;
    expect(updateSql).toContain("FROM preserve.memory m");
    expect(updateSql).toContain("JOIN preserve.memory_support ms");
    expect(updateSql).toContain("LEFT JOIN LATERAL");
    expect(updateSql).toContain("JOIN preserve.entity p");
    expect(updateSql).toContain("AND p.tenant = ?");
    expect(updateSql).toContain("AND p.entity_type = 'project'");
    expect(updateSql).toContain("WHERE f.fact_id = ms.fact_id");
    expect(updateSql).toContain("AND f.tenant = ?");
    expect(updateSql).toContain("WHERE ep.episode_id = ms.episode_id");
    expect(updateSql).toContain("AND ep.tenant = ?");
    expect(updateSql).toContain("WHERE m.memory_id = cp.memory_id");
    expect(updateSql).toContain("AND m.tenant = ?");
    expect(updateSql).toContain("AND cp.project_count = 1");
    expect(calls[1].values.filter((value) => value === "tenant-a")).toHaveLength(6);

    const unresolvedSql = calls[2].text;
    expect(unresolvedSql).toContain("FROM preserve.memory m");
    expect(unresolvedSql).toContain("AND p.tenant = ?");
    expect(unresolvedSql).toContain("AND f.tenant = ?");
    expect(unresolvedSql).toContain("AND ep.tenant = ?");
    expect(unresolvedSql).toContain("WHERE project_count <> 1");
  });
});
