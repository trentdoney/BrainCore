import { fileURLToPath } from "url";
import { dirname, join } from "path";

export const MIGRATION_FILES = [
  "001_preserve_schema.sql",
  "003_seed_entities.sql",
  "004_seed_projects.example.sql",
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

async function runPsql(dsn: string, args: string[], label: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["psql", "-v", "ON_ERROR_STOP=1", "-X", "-d", dsn, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (stdout.trim()) {
    console.log(stdout.trimEnd());
  }
  if (status !== 0) {
    if (stderr.trim()) {
      console.error(stderr.trimEnd());
    }
    throw new Error(`Migration step failed: ${label} (exit ${status})`);
  }
}

export async function runMigrations(dsn: string): Promise<void> {
  for (const step of getMigrationSteps()) {
    console.log(`[migrate] ${step.label}`);
    if (step.kind === "bootstrap") {
      await runPsql(dsn, ["-c", step.sql], step.label);
    } else {
      await runPsql(dsn, ["-f", step.path], step.label);
    }
  }
}
