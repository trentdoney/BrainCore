import postgres from "postgres";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

export const MIGRATION_LEDGER_TABLE = "preserve.schema_migration";

export const MIGRATION_FILES = [
  "001_preserve_schema.sql",
  "003_seed_entities.sql",
  "005_priority_tenant.sql",
  "006_source_type_values.sql",
  "007_eval_run.sql",
  "008_eval_case.sql",
  "009_schema_alignment.sql",
  "010_tenant_isolation.sql",
] as const;

type Step =
  | { kind: "bootstrap"; sql: string; label: string }
  | { kind: "file"; path: string; label: string };

type SqlClient = ReturnType<typeof postgres>;

export function getMigrationSteps(): Step[] {
  const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
  return [
    {
      kind: "bootstrap",
      label: "bootstrap schema/extensions",
      sql: [
        "CREATE SCHEMA IF NOT EXISTS preserve;",
        "CREATE EXTENSION IF NOT EXISTS vector;",
        "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
      ].join(" "),
    },
    ...MIGRATION_FILES.map((file) => ({
      kind: "file" as const,
      path: join(sqlDir, file),
      label: file,
    })),
  ];
}

export function migrationChecksum(sqlText: string): string {
  return createHash("sha256").update(sqlText, "utf-8").digest("hex");
}

export function getStepSql(step: Step): string {
  return step.kind === "bootstrap" ? step.sql : readFileSync(step.path, "utf-8");
}

export function markerSqlForMigration(label: string): string | null {
  switch (label) {
    case "001_preserve_schema.sql":
      return `
        SELECT
          to_regclass('preserve.artifact') IS NOT NULL
          AND to_regclass('preserve.entity') IS NOT NULL
          AND to_regclass('preserve.fact') IS NOT NULL
          AND to_regtype('preserve.source_type') IS NOT NULL AS applied
      `;
    case "003_seed_entities.sql":
      return `
        SELECT count(*) >= 3 AS applied
        FROM preserve.entity
        WHERE tenant = 'default'
          AND entity_type = 'device'::preserve.entity_type
          AND canonical_name IN ('server-a', 'server-b', 'workstation')
      `;
    case "005_priority_tenant.sql":
      return `
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'preserve' AND table_name = 'artifact' AND column_name = 'priority'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'preserve' AND table_name = 'artifact' AND column_name = 'tenant'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'preserve' AND table_name = 'fact' AND column_name = 'tenant'
          ) AS applied
      `;
    case "006_source_type_values.sql":
      return `
        SELECT count(*) = 5 AS applied
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'preserve'
          AND t.typname = 'source_type'
          AND e.enumlabel IN (
            'codex_session',
            'codex_shared',
            'discord_conversation',
            'telegram_chat',
            'monitoring_alert'
          )
      `;
    case "007_eval_run.sql":
      return `SELECT to_regclass('preserve.eval_run') IS NOT NULL AS applied`;
    case "008_eval_case.sql":
      return `SELECT to_regclass('preserve.eval_case') IS NOT NULL AS applied`;
    case "009_schema_alignment.sql":
      return `
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'preserve' AND table_name = 'artifact' AND column_name = 'project_entity_id'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'preserve' AND table_name = 'fact' AND column_name = 'importance_score'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'preserve' AND table_name = 'memory' AND column_name = 'last_supported_at'
          ) AS applied
      `;
    case "010_tenant_isolation.sql":
      return `
        WITH constraints AS (
          SELECT conrelid::regclass::text AS table_name, conname
          FROM pg_constraint
          WHERE connamespace = 'preserve'::regnamespace
            AND conname IN (
              'uq_artifact_tenant_source_key',
              'uq_entity_tenant_type_name',
              'uq_memory_tenant_fingerprint',
              'artifact_source_key_key',
              'entity_entity_type_canonical_name_key',
              'memory_fingerprint_key'
            )
        )
        SELECT
          EXISTS (SELECT 1 FROM constraints WHERE table_name = 'preserve.artifact' AND conname = 'uq_artifact_tenant_source_key')
          AND EXISTS (SELECT 1 FROM constraints WHERE table_name = 'preserve.entity' AND conname = 'uq_entity_tenant_type_name')
          AND EXISTS (SELECT 1 FROM constraints WHERE table_name = 'preserve.memory' AND conname = 'uq_memory_tenant_fingerprint')
          AND NOT EXISTS (SELECT 1 FROM constraints WHERE conname IN (
            'artifact_source_key_key',
            'entity_entity_type_canonical_name_key',
            'memory_fingerprint_key'
          )) AS applied
      `;
    default:
      return null;
  }
}

async function ensureLedger(sql: SqlClient): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS preserve.schema_migration (
      migration_name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT NOT NULL DEFAULT current_user,
      execution_ms INTEGER NOT NULL DEFAULT 0,
      baseline BOOLEAN NOT NULL DEFAULT false
    )
  `);
}

async function migrationRecord(
  sql: SqlClient,
  label: string,
): Promise<{ checksum: string; baseline: boolean } | null> {
  const rows = await sql`
    SELECT checksum, baseline
    FROM preserve.schema_migration
    WHERE migration_name = ${label}
  `;
  return rows[0] as { checksum: string; baseline: boolean } | null;
}

async function recordMigration(
  sql: SqlClient,
  label: string,
  checksum: string,
  executionMs: number,
  baseline: boolean,
): Promise<void> {
  await sql`
    INSERT INTO preserve.schema_migration (
      migration_name, checksum, execution_ms, baseline
    ) VALUES (
      ${label}, ${checksum}, ${executionMs}, ${baseline}
    )
    ON CONFLICT (migration_name) DO NOTHING
  `;
}

async function updateBaselinedChecksum(
  sql: SqlClient,
  label: string,
  checksum: string,
): Promise<void> {
  await sql`
    UPDATE preserve.schema_migration
    SET checksum = ${checksum},
        applied_at = now(),
        applied_by = current_user
    WHERE migration_name = ${label}
      AND baseline = true
  `;
}

async function handleExistingMigration(
  sql: SqlClient,
  step: Step,
  checksum: string,
): Promise<boolean> {
  const existing = await migrationRecord(sql, step.label);
  if (!existing) return false;

  if (existing.checksum === checksum) {
    console.log("  already applied");
    return true;
  }

  const canRefreshBaseline = step.kind === "bootstrap"
    ? existing.baseline
    : existing.baseline && await migrationAppearsApplied(sql, step.label);

  if (canRefreshBaseline) {
    await updateBaselinedChecksum(sql, step.label, checksum);
    console.log("  updated baselined checksum");
    return true;
  }

  throw new Error(`Migration checksum mismatch: ${step.label}`);
}

async function schemaAlreadyExists(sql: SqlClient): Promise<boolean> {
  const [row] = await sql.unsafe(`
    SELECT to_regclass('preserve.artifact') IS NOT NULL AS exists
  `);
  return Boolean(row?.exists);
}

async function migrationAppearsApplied(sql: SqlClient, label: string): Promise<boolean> {
  const markerSql = markerSqlForMigration(label);
  if (!markerSql) return false;
  const [row] = await sql.unsafe(markerSql);
  return Boolean(row?.applied);
}

async function executeMigrationSql(sql: SqlClient, sqlText: string): Promise<void> {
  await sql.unsafe(sqlText);
}

export async function runMigrations(dsn: string): Promise<void> {
  const sql = postgres(dsn, {
    max: 1,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });

  try {
    const steps = getMigrationSteps();
    const preexistingSchema = await schemaAlreadyExists(sql);

    for (const step of steps) {
      const sqlText = getStepSql(step);
      const checksum = migrationChecksum(sqlText);
      console.log(`[migrate] ${step.label}`);

      if (step.kind === "bootstrap") {
        await executeMigrationSql(sql, sqlText);
        await ensureLedger(sql);
        if (!await handleExistingMigration(sql, step, checksum)) {
          await recordMigration(sql, step.label, checksum, 0, preexistingSchema);
          console.log(preexistingSchema ? "  baselined existing schema" : "  applied");
        }
        continue;
      }

      if (await handleExistingMigration(sql, step, checksum)) {
        continue;
      }

      if (preexistingSchema && await migrationAppearsApplied(sql, step.label)) {
        await recordMigration(sql, step.label, checksum, 0, true);
        console.log("  baselined existing schema");
        continue;
      }

      const started = performance.now();
      await executeMigrationSql(sql, sqlText);
      const executionMs = Math.max(0, Math.round(performance.now() - started));
      await recordMigration(sql, step.label, checksum, executionMs, false);
      console.log(`  applied in ${executionMs}ms`);
    }
  } finally {
    await sql.end();
  }
}
