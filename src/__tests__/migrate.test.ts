import { describe, expect, test } from "bun:test";
import {
  MIGRATION_FILES,
  getMigrationSteps,
  markerSqlForMigration,
  migrationChecksum,
} from "../migrate";

describe("migration plan", () => {
  test("uses the locked launch order", () => {
    expect([...MIGRATION_FILES]).toEqual([
      "001_preserve_schema.sql",
      "003_seed_entities.sql",
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

  test("has detection markers for every file migration", () => {
    for (const file of MIGRATION_FILES) {
      expect(markerSqlForMigration(file)).toContain("applied");
    }
  });

  test("migration checksums are stable sha256 strings", () => {
    expect(migrationChecksum("SELECT 1;")).toMatch(/^[a-f0-9]{64}$/);
    expect(migrationChecksum("SELECT 1;")).toBe(migrationChecksum("SELECT 1;"));
    expect(migrationChecksum("SELECT 1;")).not.toBe(migrationChecksum("SELECT 2;"));
  });
});
