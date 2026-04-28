import { describe, expect, test } from "bun:test";
import { archiveProjectWithDb, type ArchiveSqlLike } from "../project/archive";

interface SqlCall {
  text: string;
  values: unknown[];
}

function makeSqlStub(responses: unknown[][]) {
  const calls: SqlCall[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(responses.shift() ?? []);
  }) as ArchiveSqlLike;
  sql.json = (value: unknown) => ({ json: value });
  return { sql, calls };
}

describe("archiveProjectWithDb", () => {
  test("archives only the tenant-local project and scopes priority support checks", async () => {
    const now = new Date("2026-04-24T12:00:00.000Z");
    const { sql, calls } = makeSqlStub([
      [{ entity_id: "11111111-1111-1111-1111-111111111111" }],
      [],
      [{ n: "3" }],
      [{ memory_id: "22222222-2222-2222-2222-222222222222" }],
    ]);

    const result = await archiveProjectWithDb(
      sql,
      "tenant-a",
      "BrainCore",
      "phase complete",
      now,
    );

    expect(result).toEqual({
      project: "BrainCore",
      entityId: "11111111-1111-1111-1111-111111111111",
      factsCount: 3,
      memoriesRetired: 1,
      reason: "phase complete",
    });
    expect(calls).toHaveLength(4);

    expect(calls[0].text).toContain("FROM preserve.entity");
    expect(calls[0].text).toContain("WHERE tenant = ?");
    expect(calls[0].text).toContain("AND entity_type = 'project'");
    expect(calls[0].values).toEqual(["tenant-a", "BrainCore"]);

    expect(calls[1].text).toContain("UPDATE preserve.entity");
    expect(calls[1].text).toContain("WHERE entity_id = ?");
    expect(calls[1].text).toContain("AND tenant = ?");
    expect(calls[1].text).toContain("AND entity_type = 'project'");
    expect(calls[1].values).toContain("tenant-a");
    expect(calls[1].values[0]).toEqual({
      json: {
        status: "archived",
        archived_at: "2026-04-24T12:00:00.000Z",
        archive_reason: "phase complete",
      },
    });

    expect(calls[2].text).toContain("FROM preserve.fact");
    expect(calls[2].text).toContain("WHERE tenant = ?");
    expect(calls[2].text).toContain("AND project_entity_id = ?");

    expect(calls[3].text).toContain("UPDATE preserve.memory AS m");
    expect(calls[3].text).toContain("WHERE m.tenant = ?");
    expect(calls[3].text).toContain("AND m.project_entity_id = ?");
    expect(calls[3].text).toContain("WHERE ms.memory_id = m.memory_id");
    expect(calls[3].text).toContain("AND f.tenant = ?");
    expect(calls[3].text).toContain("AND f.project_entity_id = ?");
    expect(calls[3].text).toContain("AND f.priority = 1");
  });
});
