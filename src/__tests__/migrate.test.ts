import { describe, expect, test } from "bun:test";
import { MIGRATION_FILES, getMigrationSteps } from "../migrate";

describe("migration plan", () => {
  test("uses the locked launch order", () => {
    expect([...MIGRATION_FILES]).toEqual([
      "001_preserve_schema.sql",
      "003_seed_entities.sql",
      "004_seed_projects.example.sql",
      "005_priority_tenant.sql",
      "006_source_type_values.sql",
      "007_eval_run.sql",
      "008_eval_case.sql",
      "009_schema_alignment.sql",
      "010_tenant_isolation.sql",
    ]);
  });

  test("bootstraps schema before file migrations", () => {
    const steps = getMigrationSteps();
    expect(steps[0]).toMatchObject({
      kind: "bootstrap",
      label: "bootstrap schema/extensions",
    });
    expect(steps.slice(1).map((s) => s.label)).toEqual([...MIGRATION_FILES]);
  });
});
