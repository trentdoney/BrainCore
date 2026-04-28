import { describe, expect, test } from "bun:test";
import { queueOversizedIncidentArtifact } from "../extract/oversized-artifact";

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
  return { sql, calls };
}

describe("queueOversizedIncidentArtifact", () => {
  test("scopes artifact lookup, insert, and update to the active tenant", async () => {
    const { sql, calls } = makeSqlStub([
      [],
      [{ artifact_id: "00000000-0000-0000-0000-000000000001" }],
      [],
      [],
    ]);

    const artifactId = await queueOversizedIncidentArtifact(sql, {
      slug: "INC-tenant-collision",
      sourceKey: "10_projects/ExampleProject/incidents/INC-tenant-collision",
      scopePath: "project:ExampleProject/incident:INC-tenant-collision",
      incidentPath: "/vault/incidents/INC-tenant-collision",
      fileSha256: "a".repeat(64),
      fileSize: 9_999_999,
      tenant: "tenant-a",
    });

    expect(artifactId).toBe("00000000-0000-0000-0000-000000000001");
    expect(calls).toHaveLength(4);
    expect(calls[0].text).toContain("WHERE source_key = ?");
    expect(calls[0].text).toContain("AND tenant = ?");
    expect(calls[0].values).toContain("10_projects/ExampleProject/incidents/INC-tenant-collision");
    expect(calls[0].values).toContain("tenant-a");
    expect(calls[1].values).toContain("project:ExampleProject/incident:INC-tenant-collision");
    expect(calls[1].text).toContain("can_query_raw, can_promote_memory, tenant,");
    expect(calls[1].values).toContain("tenant-a");
    expect(calls[2].text).toContain("WHERE artifact_id = ?::uuid");
    expect(calls[2].text).toContain("AND tenant = ?");
    expect(calls[2].values).toContain("tenant-a");
  });
});
