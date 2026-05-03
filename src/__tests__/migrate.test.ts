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
      "011_source_integrations.sql",
      "012_memory_graph.sql",
      "013_event_frames.sql",
      "014_procedure_memory.sql",
      "015_reflection_health.sql",
      "016_active_agent_sessions.sql",
      "017_multimodal_layout_memory.sql",
      "018_working_memory_operations.sql",
      "019_multimodal_ingest_anchor.sql",
      "020_embedding_index_roles.sql",
      "021_enterprise_lifecycle.sql",
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

  test("memory graph marker is safe before graph tables exist", () => {
    expect(markerSqlForMigration("012_memory_graph.sql")).toContain(
      "to_regclass('preserve.memory_edge')",
    );
    expect(markerSqlForMigration("012_memory_graph.sql")).not.toContain(
      "'preserve.memory_edge'::regclass",
    );
  });

  test("event frame marker is safe before event frame table exists", () => {
    expect(markerSqlForMigration("013_event_frames.sql")).toContain(
      "to_regclass('preserve.event_frame')",
    );
    expect(markerSqlForMigration("013_event_frames.sql")).not.toContain(
      "'preserve.event_frame'::regclass",
    );
  });

  test("procedure memory marker is safe before procedure tables exist", () => {
    expect(markerSqlForMigration("014_procedure_memory.sql")).toContain(
      "to_regclass('preserve.procedure')",
    );
    expect(markerSqlForMigration("014_procedure_memory.sql")).toContain(
      "to_regclass('preserve.procedure_step')",
    );
    expect(markerSqlForMigration("014_procedure_memory.sql")).not.toContain(
      "'preserve.procedure'::regclass",
    );
  });

  test("reflection health marker is safe before reflection tables exist", () => {
    expect(markerSqlForMigration("015_reflection_health.sql")).toContain(
      "to_regclass('preserve.reflection_class')",
    );
    expect(markerSqlForMigration("015_reflection_health.sql")).not.toContain(
      "'preserve.reflection_class'::regclass",
    );
  });

  test("active agent session marker is safe before session tables exist", () => {
    expect(markerSqlForMigration("016_active_agent_sessions.sql")).toContain(
      "to_regclass('preserve.task_session')",
    );
    expect(markerSqlForMigration("016_active_agent_sessions.sql")).toContain(
      "to_regclass('preserve.working_memory')",
    );
    expect(markerSqlForMigration("016_active_agent_sessions.sql")).not.toContain(
      "'preserve.task_session'::regclass",
    );
  });

  test("multimodal layout marker is safe before multimodal tables exist", () => {
    expect(markerSqlForMigration("017_multimodal_layout_memory.sql")).toContain(
      "to_regclass('preserve.embedding_index')",
    );
    expect(markerSqlForMigration("017_multimodal_layout_memory.sql")).toContain(
      "to_regclass('preserve.media_artifact')",
    );
    expect(markerSqlForMigration("017_multimodal_layout_memory.sql")).toContain(
      "to_regclass('preserve.visual_region')",
    );
    expect(markerSqlForMigration("017_multimodal_layout_memory.sql")).not.toContain(
      "'preserve.embedding_index'::regclass",
    );
  });

  test("working memory operations marker is safe before operation columns exist", () => {
    expect(markerSqlForMigration("018_working_memory_operations.sql")).toContain(
      "to_regclass('preserve.working_memory')",
    );
    expect(markerSqlForMigration("018_working_memory_operations.sql")).toContain(
      "promotion_target_kind",
    );
    expect(markerSqlForMigration("018_working_memory_operations.sql")).not.toContain(
      "'preserve.working_memory'::regclass",
    );
  });

  test("multimodal ingest anchor marker is safe before anchor columns exist", () => {
    expect(markerSqlForMigration("019_multimodal_ingest_anchor.sql")).toContain(
      "to_regclass('preserve.media_artifact')",
    );
    expect(markerSqlForMigration("019_multimodal_ingest_anchor.sql")).toContain(
      "ingest_run_id",
    );
    expect(markerSqlForMigration("019_multimodal_ingest_anchor.sql")).toContain(
      "idx_visual_region_ingest_batch",
    );
    expect(markerSqlForMigration("019_multimodal_ingest_anchor.sql")).not.toContain(
      "'preserve.media_artifact'::regclass",
    );
  });

  test("embedding index role marker is safe before role expansion exists", () => {
    expect(markerSqlForMigration("020_embedding_index_roles.sql")).toContain(
      "to_regclass('preserve.embedding_index')",
    );
    expect(markerSqlForMigration("020_embedding_index_roles.sql")).toContain(
      "media_caption",
    );
    expect(markerSqlForMigration("020_embedding_index_roles.sql")).toContain(
      "visual_ocr",
    );
    expect(markerSqlForMigration("020_embedding_index_roles.sql")).not.toContain(
      "'preserve.embedding_index'::regclass",
    );
  });

  test("enterprise lifecycle marker checks additive lifecycle tables", () => {
    expect(markerSqlForMigration("021_enterprise_lifecycle.sql")).toContain(
      "to_regclass('preserve.lifecycle_outbox')",
    );
    expect(markerSqlForMigration("021_enterprise_lifecycle.sql")).toContain(
      "uq_lifecycle_outbox_tenant_idempotency",
    );
    expect(markerSqlForMigration("021_enterprise_lifecycle.sql")).toContain(
      "trg_lifecycle_feedback_append_only",
    );
    expect(markerSqlForMigration("021_enterprise_lifecycle.sql")).toContain("lock_version");
    expect(markerSqlForMigration("021_enterprise_lifecycle.sql")).not.toContain(
      "'preserve.lifecycle_outbox'::regclass",
    );
  });

  test("migration checksums are stable sha256 strings", () => {
    expect(migrationChecksum("SELECT 1;")).toMatch(/^[a-f0-9]{64}$/);
    expect(migrationChecksum("SELECT 1;")).toBe(migrationChecksum("SELECT 1;"));
    expect(migrationChecksum("SELECT 1;")).not.toBe(migrationChecksum("SELECT 2;"));
  });
});
