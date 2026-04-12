#!/usr/bin/env bun
/**
 * cli.ts — BrainCore CLI entry point.
 * Wires all commands: archive, extract, consolidate, publish-notes, etc.
 */

import { config } from "./config";

const command = process.argv[2];
const args = process.argv.slice(3);

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function printUsage(): void {
  console.log("Usage: bun src/cli.ts <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  extract            Extract knowledge from incidents/sessions/PAI");
  console.log("    --incident <path>  Extract a single incident");
  console.log("    --session <path>   Extract a Claude session (JSONL)");
  console.log("    --pai-memory       Extract PAI AUTO memory files");
  console.log("    --codex-history    Extract Codex CLI history + sessions");
  console.log("    --codex-shared     Extract CODEX_SHARED memory structure");
  console.log("    --discord          Extract Discord digest micro_summaries");
  console.log("    --telegram         Extract Telegram chat messages");
  console.log("    --grafana          Extract Grafana dashboards/alerts");
  console.log("    --pending          Extract all pending artifacts");
  console.log("    --use-claude       Escalate to Claude CLI for semantic");
  console.log("    --skip-semantic    Skip LLM extraction, deterministic only");
  console.log("    --dry-run          Print results without database writes");
  console.log("  archive --pending    Archive discovered artifacts");
  console.log("  consolidate --delta  Compile patterns and playbooks");
  console.log("  publish-notes        Publish memories to markdown");
  console.log("    --changed          Only publish changed memories");
  console.log("    --scope <path>     Filter by scope path prefix");
  console.log("  eval                 Run extraction evaluation");
  console.log("    --run              Run eval on all gold set cases");
  console.log("    --report           Print last eval report");
  console.log("  gate-check           Report blocked/failed artifacts");
  console.log("  health-check         Check vLLM endpoint health");
  console.log("  schema-check         Verify required DB constraints");
  console.log("  project              Project lifecycle commands");
  console.log("    list               Show projects with artifact/fact counts");
  console.log("    tag --retag-all    Re-run project resolution on all artifacts");
  console.log("    bootstrap-defaults Clone default project seeds into the active tenant");
  console.log("    archive <name>     Archive a project (--reason 'text')");
  console.log("    merge <src> --into <tgt>  Merge source project into target");
  console.log("    fork <parent> --into <child1> <child2>  Fork a project");
  console.log("    summary <name>     Detailed project summary");
  console.log("  maintenance          DB maintenance commands");
  console.log("    --vacuum           VACUUM ANALYZE core tables");
  console.log("    --detect-stale     Detect & demote stale memories");
  console.log("    --stats            Show table counts, index sizes, staleness");
  console.log("  migrate              Run database migrations 001-010");
  console.log("  help, --help, -h     Show this help message");
}

// Handle help flags explicitly BEFORE the commands[] dispatch so they never
// touch the database proxy or fall through the unknown-command error branch.
if (!command || command === "--help" || command === "-h" || command === "help") {
  printUsage();
  process.exit(0);
}

// ── Commands ─────────────────────────────────────────────────────────────────

const commands: Record<string, () => Promise<void>> = {
  archive: async () => {
    const pending = hasFlag("pending");
    if (!pending) {
      console.error("Usage: braincore archive --pending");
      process.exit(1);
    }
    const { sql, testConnection } = await import("./db");
    console.log("\n=== BrainCore Archive ===\n");
    const connected = await testConnection();
    if (!connected) { process.exit(1); }

    const artifacts = await sql`
      SELECT artifact_id, source_key, original_path, sha256
      FROM preserve.artifact
      WHERE tenant = ${config.tenant}
        AND preservation_state = 'discovered'
      ORDER BY discovered_at ASC
      LIMIT 50
    `;

    console.log(`Found ${artifacts.length} pending artifacts to archive.`);

    for (const art of artifacts) {
      try {
        await sql`
          UPDATE preserve.artifact
          SET preservation_state = 'archived'::preserve.preservation_state,
              updated_at = now()
          WHERE artifact_id = ${art.artifact_id}
            AND tenant = ${config.tenant}
        `;
        console.log(`  Archived: ${art.source_key}`);
      } catch (e: any) {
        console.error(`  Failed to archive ${art.source_key}: ${e.message}`);
      }
    }
    await sql.end();
  },

  extract: async () => {
    const incidentPath = getFlag("incident");
    const sessionPath = getFlag("session");
    const paiMemory = hasFlag("pai-memory");
    const codexHistory = hasFlag("codex-history");
    const codexShared = hasFlag("codex-shared");
    const discord = hasFlag("discord");
    const pending = hasFlag("pending");
    const useClaude = hasFlag("use-claude");
    const skipSemantic = hasFlag("skip-semantic");
    const dryRun = hasFlag("dry-run");
    const telegram = hasFlag("telegram");
    const grafana = hasFlag("grafana");

    if (sessionPath) {
      await extractSession(sessionPath);
      return;
    }

    if (paiMemory) {
      await extractPAI();
      return;
    }

    if (codexHistory) {
      await extractCodexHistory(dryRun);
      return;
    }

    if (codexShared) {
      await extractCodexShared(dryRun);
      return;
    }

    if (discord) {
      await extractDiscord(dryRun);
      return;
    }

    if (telegram) {
      await extractTelegram(dryRun);
      return;
    }

    if (grafana) {
      await extractGrafana(dryRun);
      return;
    }

    if (!incidentPath && !pending) {
      console.error(
        "Usage: braincore extract --incident <path> [--use-claude] [--skip-semantic] [--dry-run]",
      );
      console.error(
        "       braincore extract --pending [--use-claude] [--skip-semantic]",
      );
      console.error(
        "       braincore extract --session <path>",
      );
      console.error(
        "       braincore extract --pai-memory",
      );
      console.error(
        "       braincore extract --codex-history [--dry-run]",
      );
      console.error(
        "       braincore extract --codex-shared [--dry-run]",
      );
      console.error(
        "       braincore extract --discord [--dry-run]",
      );
      console.error(
        "       braincore extract --telegram [--dry-run]",
      );
      console.error(
        "       braincore extract --grafana [--dry-run]",
      );
    }

    if (incidentPath) {
      await extractSingleIncident(incidentPath, {
        useClaude,
        skipSemantic,
        dryRun,
      });
    } else if (pending) {
      await extractPendingArtifacts({ useClaude, skipSemantic });
    }
  },

  "health-check": async () => {
    const { checkAllEndpoints } = await import("./llm/health");
    console.log("Checking vLLM endpoints...\n");
    const results = await checkAllEndpoints();
    for (const r of results) {
      const icon = r.healthy ? "OK" : "FAIL";
      const model = r.model ? ` (${r.model})` : "";
      const latency = r.latencyMs ? ` ${r.latencyMs}ms` : "";
      const error = r.error ? ` -- ${r.error}` : "";
      console.log(
        `  [${icon}] ${r.name} ${r.url}${model}${latency}${error}`,
      );
    }
  },

  "schema-check": async () => {
    const { sql, testConnection } = await import("./db");
    console.log("\n=== BrainCore Schema Check ===\n");
    const connected = await testConnection();
    if (!connected) { process.exit(1); }

    const required = new Set([
      "preserve.artifact:uq_artifact_tenant_source_key",
      "preserve.entity:uq_entity_tenant_type_name",
      "preserve.memory:uq_memory_tenant_fingerprint",
    ]);
    const oldTenantBlind = new Set([
      "preserve.artifact:artifact_source_key_key",
      "preserve.entity:entity_entity_type_canonical_name_key",
      "preserve.memory:memory_fingerprint_key",
    ]);

    const rows = await sql`
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
      ORDER BY table_name, conname
    `;

    const present = new Set(rows.map((r: any) => `${r.table_name}:${r.conname}`));
    const missing = [...required].filter((key) => !present.has(key));
    const stale = [...oldTenantBlind].filter((key) => present.has(key));

    if (missing.length > 0 || stale.length > 0) {
      if (missing.length > 0) {
        console.error("Missing required tenant-scoped constraints:");
        for (const key of missing) console.error(`  - ${key}`);
      }
      if (stale.length > 0) {
        console.error("Stale tenant-blind constraints still present:");
        for (const key of stale) console.error(`  - ${key}`);
      }
      await sql.end();
      process.exit(1);
    }

    console.log("OK: tenant-scoped uniqueness constraints are active.");
    console.log("OK: old tenant-blind uniqueness constraints are absent.");
    await sql.end();
  },

  consolidate: async () => {
    const delta = hasFlag("delta");
    const { sql, testConnection } = await import("./db");
    const { findPatternCandidates } = await import("./consolidate/patterns");
    const { updateMemories } = await import("./consolidate/updater");
    const { compilePlaybooks } = await import("./consolidate/playbooks");

    console.log("\n=== BrainCore Consolidate ===\n");
    const connected = await testConnection();
    if (!connected) { process.exit(1); }

    console.log("[1/3] Finding pattern candidates...");
    const candidates = await findPatternCandidates(sql);
    console.log(`  Found ${candidates.length} pattern candidates.`);

    if (candidates.length > 0) {
      console.log("\n[2/3] Updating memories...");
      const result = await updateMemories(candidates, sql);
      console.log(`  Added: ${result.added}`);
      console.log(`  Updated: ${result.updated}`);
      console.log(`  Retired: ${result.retired}`);
    } else {
      console.log("\n[2/3] No candidates to process.");
    }

    console.log("\n[3/3] Compiling playbooks...");
    const playbooksCreated = await compilePlaybooks(sql);
    console.log(`  Playbooks created/updated: ${playbooksCreated}`);

    console.log("\nConsolidation complete.");
    await sql.end();
  },

  "publish-notes": async () => {
    const changed = hasFlag("changed");
    const scope = getFlag("scope");
    const { sql, testConnection } = await import("./db");
    const { publishNotes } = await import("./publish/markdown");

    console.log("\n=== BrainCore Publish Notes ===\n");
    const connected = await testConnection();
    if (!connected) { process.exit(1); }

    const result = await publishNotes(sql, scope);
    console.log(`  Published: ${result.published} notes`);
    console.log(`  Path: ${result.path}`);
    await sql.end();
  },

  eval: async () => {
    const run = hasFlag("run");
    const report = hasFlag("report");

    if (!run && !report) {
      console.error("Usage: braincore eval --run    (run eval on all gold set cases)");
      console.error("       braincore eval --report (print last eval report)");
      process.exit(1);
    }

    const { sql, testConnection } = await import("./db");
    console.log("\n=== BrainCore Eval ===\n");
    const connected = await testConnection();
    if (!connected) { process.exit(1); }

    if (run) {
      const { runEval, printReport, storeRun } = await import("./eval/runner");

      console.log("[1/3] Running eval on gold set...");
      const { metrics, cases } = await runEval(sql);

      console.log("[2/3] Storing eval run...");
      const runId = await storeRun(sql, metrics, cases);
      console.log(`  Eval run ID: ${runId}`);

      console.log("[3/3] Generating report...");
      printReport(metrics, cases);
    }

    if (report && !run) {
      // Load last eval run and print report
      const [lastRun] = await sql`
        SELECT eval_run_id, pipeline_version, model_name, prompt_version,
               results, metrics, created_at
        FROM preserve.eval_run
        ORDER BY created_at DESC
        LIMIT 1
      `;

      if (!lastRun) {
        console.log("No eval runs found. Run: braincore eval --run");
        await sql.end();
        return;
      }

      console.log(`Last eval run: ${lastRun.eval_run_id} (${lastRun.created_at})`);
      console.log(`Pipeline: ${lastRun.pipeline_version}, Model: ${lastRun.model_name}`);

      const { printReport } = await import("./eval/runner");
      printReport(lastRun.metrics, lastRun.results);
    }

    await sql.end();
  },

  "gate-check": async () => {
    const { sql, testConnection } = await import("./db");
    console.log("\n=== BrainCore Gate Check ===\n");
    const connected = await testConnection();
    if (!connected) { process.exit(1); }

    const blocked = await sql`
      SELECT artifact_id, source_key, preservation_state, original_path
      FROM preserve.artifact
      WHERE tenant = ${config.tenant}
        AND preservation_state IN ('blocked', 'failed', 'pending_escalation')
      ORDER BY updated_at DESC
    `;

    if (blocked.length === 0) {
      console.log("  No blocked or failed artifacts. All clear.");
    } else {
      console.log(`  ${blocked.length} artifact(s) need attention:\n`);
      for (const b of blocked) {
        console.log(`  [${b.preservation_state}] ${b.source_key}`);
        console.log(`    Path: ${b.original_path}`);
      }
    }

    const reviewReasons = await sql`
      SELECT reason, count(*) AS n
      FROM preserve.review_queue
      WHERE status = 'pending'
      GROUP BY reason
      ORDER BY n DESC, reason ASC
    `.catch(() => [] as any[]);

    if (reviewReasons.length > 0) {
      console.log("\n  Pending review reasons:");
      for (const row of reviewReasons) {
        console.log(`    ${row.reason}: ${row.n}`);
      }
    }
    await sql.end();
  },

  project: async () => {
    const subcommand = args[0];
    const { sql, testConnection } = await import("./db");

    if (subcommand === "list") {
      console.log("\n=== BrainCore Projects ===\n");
      const connected = await testConnection();
      if (!connected) { process.exit(1); }

      const rows = await sql`
        SELECT
          e.canonical_name AS project,
          (SELECT count(*) FROM preserve.artifact a WHERE a.project_entity_id = e.entity_id AND a.tenant = ${config.tenant}) AS artifacts,
          (SELECT count(*) FROM preserve.fact f WHERE f.project_entity_id = e.entity_id AND f.tenant = ${config.tenant}) AS facts,
          (SELECT count(*) FROM preserve.segment s WHERE s.project_entity_id = e.entity_id AND s.tenant = ${config.tenant}) AS segments,
          (SELECT count(*) FROM preserve.episode ep WHERE ep.project_entity_id = e.entity_id AND ep.tenant = ${config.tenant}) AS episodes,
          (SELECT count(*) FROM preserve.memory m WHERE m.project_entity_id = e.entity_id AND m.tenant = ${config.tenant}) AS memories,
          (SELECT string_agg(psm.service_name, ', ' ORDER BY psm.service_name) FROM preserve.project_service_map psm WHERE psm.project_entity_id = e.entity_id) AS services
        FROM preserve.entity e
        WHERE e.tenant = ${config.tenant}
          AND e.entity_type = 'project'
        ORDER BY artifacts DESC, e.canonical_name
      `;

      if (rows.length === 0) {
        console.log("No projects found. Seed default projects or run `braincore project bootstrap-defaults` for this tenant.");
        await sql.end();
        return;
      }

      // Header
      console.log(
        "Project".padEnd(22) +
        "Artifacts".padStart(10) +
        "Facts".padStart(8) +
        "Segments".padStart(10) +
        "Episodes".padStart(10) +
        "Memories".padStart(10)
      );
      console.log("-".repeat(70));

      for (const r of rows) {
        console.log(
          String(r.project).padEnd(22) +
          String(r.artifacts).padStart(10) +
          String(r.facts).padStart(8) +
          String(r.segments).padStart(10) +
          String(r.episodes).padStart(10) +
          String(r.memories).padStart(10)
        );
      }

      // Totals
      const totals = rows.reduce(
        (acc: any, r: any) => ({
          artifacts: acc.artifacts + Number(r.artifacts),
          facts: acc.facts + Number(r.facts),
          segments: acc.segments + Number(r.segments),
          episodes: acc.episodes + Number(r.episodes),
          memories: acc.memories + Number(r.memories),
        }),
        { artifacts: 0, facts: 0, segments: 0, episodes: 0, memories: 0 }
      );
      console.log("-".repeat(70));
      console.log(
        "TOTAL (tagged)".padEnd(22) +
        String(totals.artifacts).padStart(10) +
        String(totals.facts).padStart(8) +
        String(totals.segments).padStart(10) +
        String(totals.episodes).padStart(10) +
        String(totals.memories).padStart(10)
      );

      // Untagged counts
      const [untagged] = await sql`
        SELECT
          (SELECT count(*) FROM preserve.artifact WHERE tenant = ${config.tenant} AND project_entity_id IS NULL) AS artifacts,
          (SELECT count(*) FROM preserve.fact WHERE tenant = ${config.tenant} AND project_entity_id IS NULL) AS facts,
          (SELECT count(*) FROM preserve.segment WHERE tenant = ${config.tenant} AND project_entity_id IS NULL) AS segments
      `;
      console.log(
        "(untagged)".padEnd(22) +
        String(untagged.artifacts).padStart(10) +
        String(untagged.facts).padStart(8) +
        String(untagged.segments).padStart(10)
      );

      console.log("\nServices per project:");
      for (const r of rows) {
        console.log(`  ${r.project}: ${r.services || "(none)"}`);
      }

      await sql.end();
    } else if (subcommand === "tag") {
      const retagAll = hasFlag("retag-all");
      console.log("\n=== BrainCore Project Tagger ===\n");
      console.log(retagAll ? "Re-tagging ALL artifacts..." : "Tagging untagged artifacts...");

      const connected = await testConnection();
      if (!connected) { process.exit(1); }

      const { resolveProject } = await import("./extract/project-resolver");

      // If retag-all, clear existing tags first
      if (retagAll) {
        await sql`UPDATE preserve.artifact SET project_entity_id = NULL WHERE tenant = ${config.tenant}`;
        await sql`UPDATE preserve.fact SET project_entity_id = NULL WHERE tenant = ${config.tenant}`;
        await sql`UPDATE preserve.segment SET project_entity_id = NULL WHERE tenant = ${config.tenant}`;
        await sql`UPDATE preserve.episode SET project_entity_id = NULL WHERE tenant = ${config.tenant}`;
        await sql`UPDATE preserve.memory SET project_entity_id = NULL WHERE tenant = ${config.tenant}`;
        console.log(`  Cleared existing project tags for tenant ${config.tenant}.`);
      }

      const artifacts = await sql`
        SELECT a.artifact_id, a.source_key, a.original_path, a.scope_path
        FROM preserve.artifact a
        WHERE a.tenant = ${config.tenant}
          AND a.project_entity_id IS NULL
      `;
      console.log(`  Found ${artifacts.length} artifacts to process.`);

      let tagged = 0;
      for (const art of artifacts) {
        // Get service entities for this artifact
        const svcRows = await sql`
          SELECT DISTINCT e.canonical_name
          FROM preserve.fact f
          JOIN preserve.entity e ON e.entity_id = f.subject_entity_id
          JOIN preserve.extraction_run er ON er.run_id = f.created_run_id
          WHERE er.artifact_id = ${art.artifact_id}
            AND f.tenant = ${config.tenant}
            AND e.tenant = ${config.tenant}
            AND e.entity_type = 'service'
        `;
        const services = svcRows.map((r: any) => r.canonical_name);

        const match = await resolveProject(services, [], art.original_path || "");
        if (match) {
          const newScope = art.scope_path
            ? `project:${match.projectName}/${art.scope_path}`
            : `project:${match.projectName}`;

          await sql`
            UPDATE preserve.artifact
            SET project_entity_id = ${match.projectEntityId}, scope_path = ${newScope}
            WHERE artifact_id = ${art.artifact_id}
              AND tenant = ${config.tenant}
          `;
          await sql`
            UPDATE preserve.fact SET project_entity_id = ${match.projectEntityId}
            FROM preserve.extraction_run er
            WHERE preserve.fact.created_run_id = er.run_id
              AND er.artifact_id = ${art.artifact_id}
              AND preserve.fact.tenant = ${config.tenant}
              AND preserve.fact.project_entity_id IS NULL
          `;
          await sql`
            UPDATE preserve.segment
            SET project_entity_id = ${match.projectEntityId}
            WHERE artifact_id = ${art.artifact_id}
              AND tenant = ${config.tenant}
              AND project_entity_id IS NULL
          `;
          await sql`
            UPDATE preserve.episode
            SET project_entity_id = ${match.projectEntityId}
            WHERE primary_artifact_id = ${art.artifact_id}
              AND tenant = ${config.tenant}
              AND project_entity_id IS NULL
          `;
          tagged++;
        }
      }

      await sql`UPDATE preserve.memory SET project_entity_id = NULL WHERE tenant = ${config.tenant}`;
      const memoryRetagged = await sql`
        WITH candidate_projects AS (
          SELECT
            ms.memory_id,
            min(cp.project_entity_id::text)::uuid AS project_entity_id,
            count(DISTINCT cp.project_entity_id) AS project_count
          FROM preserve.memory_support ms
          JOIN preserve.memory m
            ON m.memory_id = ms.memory_id
           AND m.tenant = ${config.tenant}
          JOIN LATERAL (
            SELECT f.project_entity_id
            FROM preserve.fact f
            WHERE f.fact_id = ms.fact_id
              AND f.tenant = ${config.tenant}
              AND f.project_entity_id IS NOT NULL
            UNION ALL
            SELECT ep.project_entity_id
            FROM preserve.episode ep
            WHERE ep.episode_id = ms.episode_id
              AND ep.tenant = ${config.tenant}
              AND ep.project_entity_id IS NOT NULL
          ) cp ON TRUE
          GROUP BY ms.memory_id
        )
        UPDATE preserve.memory m
        SET project_entity_id = cp.project_entity_id
        FROM candidate_projects cp
        WHERE m.memory_id = cp.memory_id
          AND m.tenant = ${config.tenant}
          AND cp.project_count = 1
        RETURNING m.memory_id
      `;
      const [ambiguousMemories] = await sql`
        WITH candidate_projects AS (
          SELECT
            ms.memory_id,
            count(DISTINCT cp.project_entity_id) AS project_count
          FROM preserve.memory_support ms
          JOIN preserve.memory m
            ON m.memory_id = ms.memory_id
           AND m.tenant = ${config.tenant}
          JOIN LATERAL (
            SELECT f.project_entity_id
            FROM preserve.fact f
            WHERE f.fact_id = ms.fact_id
              AND f.tenant = ${config.tenant}
              AND f.project_entity_id IS NOT NULL
            UNION ALL
            SELECT ep.project_entity_id
            FROM preserve.episode ep
            WHERE ep.episode_id = ms.episode_id
              AND ep.tenant = ${config.tenant}
              AND ep.project_entity_id IS NOT NULL
          ) cp ON TRUE
          GROUP BY ms.memory_id
        )
        SELECT count(*) AS n
        FROM candidate_projects
        WHERE project_count <> 1
      `;

      console.log(`  Tagged ${tagged}/${artifacts.length} artifacts.`);
      console.log(`  Rebuilt ${memoryRetagged.length} memory project tags.`);
      if (Number(ambiguousMemories?.n || 0) > 0) {
        console.log(`  Left ${ambiguousMemories.n} memories untagged due to zero or ambiguous project support.`);
      }
      await sql.end();
    } else if (subcommand === "bootstrap-defaults") {
      console.log(`\n=== BrainCore Project Bootstrap: ${config.tenant} ===\n`);
      const connected = await testConnection();
      if (!connected) { process.exit(1); }

      if (config.tenant === "default") {
        console.log("  Active tenant is default; bootstrap-defaults is a no-op.");
        await sql.end();
        return;
      }

      const seededProjects = await sql`
        INSERT INTO preserve.entity (
          tenant, entity_type, canonical_name, aliases, attrs, first_seen_at, last_seen_at, embedding
        )
        SELECT
          ${config.tenant},
          e.entity_type,
          e.canonical_name,
          e.aliases,
          COALESCE(e.attrs, '{}'::jsonb)
            - 'status'
            - 'archived_at'
            - 'archive_reason'
            - 'forked_from'
            - 'forked_at'
            - 'merged_into'
            - 'merged_at',
          e.first_seen_at,
          e.last_seen_at,
          e.embedding
        FROM preserve.entity e
        WHERE e.tenant = 'default'
          AND e.entity_type = 'project'
        ON CONFLICT (tenant, entity_type, canonical_name) DO UPDATE
          SET last_seen_at = GREATEST(preserve.entity.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING entity_id, canonical_name
      `;

      const seededMappings = await sql`
        INSERT INTO preserve.project_service_map (project_entity_id, service_name)
        SELECT target.entity_id, psm.service_name
        FROM preserve.project_service_map psm
        JOIN preserve.entity src
          ON src.entity_id = psm.project_entity_id
         AND src.tenant = 'default'
         AND src.entity_type = 'project'
        JOIN preserve.entity target
          ON target.tenant = ${config.tenant}
         AND target.entity_type = src.entity_type
         AND target.canonical_name = src.canonical_name
        ON CONFLICT (project_entity_id, service_name) DO NOTHING
        RETURNING project_entity_id
      `;

      console.log(`  Upserted ${seededProjects.length} tenant-local project rows.`);
      console.log(`  Added ${seededMappings.length} project-service mappings.`);
      await sql.end();
    } else if (subcommand === "archive") {
      const name = args[1];
      const reason = getFlag("reason") || "manual archive";
      if (!name) {
        console.error("Usage: braincore project archive <name> --reason 'text'");
        process.exit(1);
      }
      console.log(`\n=== BrainCore Project Archive: ${name} ===\n`);
      const connected = await testConnection();
      if (!connected) { process.exit(1); }
      const { archiveProject } = await import("./project/archive");
      const result = await archiveProject(name, reason);
      console.log(`  Facts: ${result.factsCount}`);
      console.log(`  Memories retired: ${result.memoriesRetired}`);
      console.log(`  Reason: ${result.reason}`);
      await sql.end();

    } else if (subcommand === "merge") {
      const source = args[1];
      const target = getFlag("into");
      if (!source || !target) {
        console.error("Usage: braincore project merge <source> --into <target>");
        process.exit(1);
      }
      console.log(`\n=== BrainCore Project Merge: ${source} -> ${target} ===\n`);
      const connected = await testConnection();
      if (!connected) { process.exit(1); }
      const { mergeProject } = await import("./project/merge");
      const result = await mergeProject(source, target);
      console.log("  Rescoped tables:", result.counts);
      await sql.end();

    } else if (subcommand === "fork") {
      const parent = args[1];
      const intoIdx = args.indexOf("--into");
      const children = intoIdx >= 0 ? args.slice(intoIdx + 1) : [];
      if (!parent || children.length === 0) {
        console.error("Usage: braincore project fork <parent> --into <child1> <child2> ...");
        process.exit(1);
      }
      console.log(`\n=== BrainCore Project Fork: ${parent} -> ${children.join(", ")} ===\n`);
      const connected = await testConnection();
      if (!connected) { process.exit(1); }
      const { forkProject } = await import("./project/fork");
      const result = await forkProject(parent, children);
      for (const child of result.children) {
        console.log(`  ${child.child}: entity ${child.entityId}, ${child.factsCopied} milestone facts`);
      }
      await sql.end();

    } else if (subcommand === "summary") {
      const name = args[1];
      if (!name) {
        console.error("Usage: braincore project summary <name>");
        process.exit(1);
      }
      console.log(`\n=== BrainCore Project Summary: ${name} ===\n`);
      const connected = await testConnection();
      if (!connected) { process.exit(1); }

      const [proj] = await sql`
        SELECT e.entity_id, e.canonical_name, e.attrs,
          (SELECT count(*) FROM preserve.fact WHERE tenant = ${config.tenant} AND project_entity_id = e.entity_id) AS facts,
          (SELECT count(*) FROM preserve.fact WHERE tenant = ${config.tenant} AND project_entity_id = e.entity_id AND priority = 1) AS milestones,
          (SELECT count(*) FROM preserve.memory WHERE tenant = ${config.tenant} AND project_entity_id = e.entity_id AND lifecycle_state = 'published') AS memories,
          (SELECT avg(importance_score)::float FROM preserve.fact WHERE tenant = ${config.tenant} AND project_entity_id = e.entity_id) AS avg_importance
        FROM preserve.entity e
        WHERE e.tenant = ${config.tenant}
          AND e.entity_type = 'project'
          AND (e.canonical_name ILIKE ${`%${name}%`} OR e.aliases::text ILIKE ${`%${name}%`})
        LIMIT 1
      `;

      if (!proj) {
        console.error(`Project not found: ${name}`);
        process.exit(1);
      }

      const attrs = proj.attrs || {};
      console.log(`  Project:     ${proj.canonical_name}`);
      console.log(`  Status:      ${attrs.status || "active"}`);
      console.log(`  Facts:       ${proj.facts}`);
      console.log(`  Milestones:  ${proj.milestones}`);
      console.log(`  Memories:    ${proj.memories}`);
      console.log(`  Avg Importance: ${(proj.avg_importance || 0).toFixed(1)}`);

      if (attrs.archived_at) console.log(`  Archived:    ${attrs.archived_at}`);
      if (attrs.merged_into) console.log(`  Merged into: ${attrs.merged_into}`);

      // Top predicates
      const preds = await sql`
        SELECT predicate, count(*) AS n FROM preserve.fact
        WHERE tenant = ${config.tenant}
          AND project_entity_id = ${proj.entity_id}
        GROUP BY predicate ORDER BY n DESC LIMIT 5
      `;
      if (preds.length > 0) {
        console.log("\n  Top predicates:");
        for (const p of preds) {
          console.log(`    ${p.predicate}: ${p.n}`);
        }
      }

      await sql.end();

    } else {
      console.error("Usage: braincore project list");
      console.error("       braincore project tag --retag-all");
      console.error("       braincore project bootstrap-defaults");
      console.error("       braincore project archive <name> --reason 'text'");
      console.error("       braincore project merge <source> --into <target>");
      console.error("       braincore project fork <parent> --into <child1> <child2>");
      console.error("       braincore project summary <name>");
      process.exit(1);
    }
  },

  maintenance: async () => {
    const vacuum = hasFlag("vacuum");
    const detectStaleFlag = hasFlag("detect-stale");
    const stats = hasFlag("stats");

    if (!vacuum && !detectStaleFlag && !stats) {
      console.error("Usage: braincore maintenance --vacuum");
      console.error("       braincore maintenance --detect-stale");
      console.error("       braincore maintenance --stats");
      process.exit(1);
    }

    const { sql, testConnection } = await import("./db");
    console.log("\n=== BrainCore Maintenance ===\n");
    const connected = await testConnection();
    if (!connected) { process.exit(1); }

    if (vacuum) {
      console.log("[vacuum] Running VACUUM ANALYZE on core tables...");
      for (const table of ["fact", "segment", "entity", "memory", "episode", "artifact"]) {
        await sql.unsafe(`VACUUM ANALYZE preserve.${table}`);
        console.log(`  VACUUM ANALYZE preserve.${table} done.`);
      }
    }

    if (detectStaleFlag) {
      console.log("[detect-stale] Checking for stale memories...");
      const { detectStale } = await import("./consolidate/updater");
      const staleCount = await detectStale(sql);
      console.log(`  Demoted ${staleCount} stale memories to draft.`);
    }

    if (stats) {
      console.log("[stats] Table row counts:");
      for (const table of ["artifact", "entity", "episode", "fact", "memory", "segment", "memory_support", "fact_evidence"]) {
        const [row] = await sql`SELECT count(*) AS n FROM ${sql(`preserve.${table}`)}`;
        console.log(`  preserve.${table}: ${row.n} rows`);
      }

      // Index sizes
      console.log("\n[stats] Index sizes:");
      const indexes = await sql`
        SELECT indexrelname AS index_name,
               pg_size_pretty(pg_relation_size(indexrelid)) AS size
        FROM pg_stat_user_indexes
        WHERE schemaname = 'preserve'
        ORDER BY pg_relation_size(indexrelid) DESC
        LIMIT 15
      `;
      for (const idx of indexes) {
        console.log(`  ${idx.index_name}: ${idx.size}`);
      }

      // Oldest unreviewed item
      console.log("\n[stats] Review queue:");
      const [oldest] = await sql`
        SELECT review_id, target_type, reason, created_at
        FROM preserve.review_queue
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      `.catch(() => [undefined]);
      if (oldest) {
        console.log(`  Oldest pending: ${oldest.target_type} - ${oldest.reason} (${oldest.created_at})`);
      } else {
        console.log("  No pending reviews.");
      }

      // Stale pattern count
      const [staleCount] = await sql`
        SELECT count(*) AS n FROM preserve.memory
        WHERE lifecycle_state = 'published'
          AND last_supported_at < now() - interval '6 months'
      `.catch(() => [{ n: 0 }]);
      console.log(`\n[stats] Potentially stale memories: ${staleCount.n}`);

      // Milestone counts
      const [milestoneCount] = await sql`
        SELECT count(*) AS n FROM preserve.fact WHERE tenant = ${config.tenant} AND priority = 1
      `;
      console.log(`[stats] Total milestones: ${milestoneCount.n}`);

      // Importance distribution
      const importDist = await sql`
        SELECT
          CASE
            WHEN importance_score >= 80 THEN 'high (80-100)'
            WHEN importance_score >= 50 THEN 'medium (50-79)'
            WHEN importance_score >= 20 THEN 'low (20-49)'
            ELSE 'minimal (0-19)'
          END AS band,
          count(*) AS n
        FROM preserve.fact
        GROUP BY 1
        ORDER BY 1
      `;
      console.log("\n[stats] Importance distribution:");
      for (const row of importDist) {
        console.log(`  ${row.band}: ${row.n}`);
      }
    }

    await sql.end();
  },

  migrate: async () => {
    const dsn = process.env.BRAINCORE_POSTGRES_DSN;
    if (!dsn) {
      console.error("Missing required environment variable: BRAINCORE_POSTGRES_DSN");
      process.exit(1);
    }

    const { runMigrations } = await import("./migrate");
    console.log("\n=== BrainCore Migrate ===\n");
    await runMigrations(dsn);
    console.log("\nMigrations complete.");
  },
};

// ── Extract Logic ────────────────────────────────────────────────────────────

interface ExtractOpts {
  useClaude: boolean;
  skipSemantic: boolean;
  dryRun?: boolean;
}

async function extractSession(sessionPath: string): Promise<void> {
  const { parseClaudeSession } = await import("./extract/session-parser");
  const { loadExtraction } = await import("./extract/load");
  const { sql, testConnection } = await import("./db");
  const { basename: bn } = await import("path");
  const { readFileSync, statSync } = await import("fs");
  const { createHash } = await import("crypto");

  const sessionId = bn(sessionPath, ".jsonl");
  console.log(`\n=== BrainCore Extract: Session ${sessionId.slice(0, 8)} ===\n`);

  console.log("[1/3] Parsing session...");
  const deterministic = await parseClaudeSession(sessionPath);
  console.log(`  Entities: ${deterministic.entities.length}`);
  console.log(`  Facts:    ${deterministic.facts.length}`);
  console.log(`  Segments: ${deterministic.segments.length}`);

  console.log("\n[2/3] Loading into preserve schema...");
  const connected = await testConnection();
  if (!connected) { process.exit(1); }

  const sourceContent = readFileSync(sessionPath, "utf-8");
  const fileSha256 = createHash("sha256").update(sourceContent, "utf-8").digest("hex");
  const fileSize = statSync(sessionPath).size;

  const sourceKey = `session:${sessionId}`;
  let artifactId: string;

  const [existing] = await sql`
    SELECT artifact_id FROM preserve.artifact
    WHERE source_key = ${sourceKey}
      AND tenant = ${config.tenant}
    LIMIT 1
  `.catch(() => [] as any[]);

  if (existing) {
    artifactId = existing.artifact_id;
    console.log(`  Using existing artifact: ${artifactId}`);
  } else {
    const [newArtifact] = await sql`
      INSERT INTO preserve.artifact (
        source_key, source_type, original_path, sha256, size_bytes,
        scope_path, can_query_raw, can_promote_memory, tenant,
        preservation_state
      ) VALUES (
        ${sourceKey},
        'claude_session'::preserve.source_type,
        ${sessionPath},
        ${fileSha256},
        ${fileSize},
        ${deterministic.scope_path},
        false, false, ${config.tenant},
        'discovered'::preserve.preservation_state
      )
      RETURNING artifact_id
    `;
    artifactId = newArtifact.artifact_id;
    console.log(`  Created artifact: ${artifactId}`);
  }

  const result = await loadExtraction(artifactId, deterministic, null, sql, sourceContent);
  console.log(`  Entities created:  ${result.entitiesCreated}`);
  console.log(`  Facts created:     ${result.factsCreated}`);
  console.log(`  Segments created:  ${result.segmentsCreated}`);

  console.log("\n[3/3] Done.");
  await sql.end();
}

async function extractPAI(): Promise<void> {
  const { parsePAIMemory } = await import("./extract/pai-parser");
  const { loadExtraction } = await import("./extract/load");
  const { sql, testConnection } = await import("./db");
  const { createHash } = await import("crypto");

  console.log("\n=== BrainCore Extract: PAI Memory ===\n");

  console.log("[1/3] Parsing PAI AUTO memory files...");
  const deterministic = await parsePAIMemory();
  console.log(`  Entities: ${deterministic.entities.length}`);
  console.log(`  Facts:    ${deterministic.facts.length}`);
  console.log(`  Segments: ${deterministic.segments.length}`);

  console.log("\n[2/3] Loading into preserve schema...");
  const connected = await testConnection();
  if (!connected) { process.exit(1); }

  const sourceContent = JSON.stringify({ scan_date: new Date().toISOString() });
  const fileSha256 = createHash("sha256").update(sourceContent, "utf-8").digest("hex");
  const sourceKey = `pai-memory-scan:${new Date().toISOString().split("T")[0]}`;

  let artifactId: string;
  const [existing] = await sql`
    SELECT artifact_id FROM preserve.artifact
    WHERE source_key = ${sourceKey}
      AND tenant = ${config.tenant}
    LIMIT 1
  `.catch(() => [] as any[]);

  if (existing) {
    artifactId = existing.artifact_id;
  } else {
    const [newArtifact] = await sql`
      INSERT INTO preserve.artifact (
        source_key, source_type, original_path, sha256, size_bytes,
        scope_path, can_query_raw, can_promote_memory, tenant,
        preservation_state
      ) VALUES (
        ${sourceKey},
        'pai_memory'::preserve.source_type,
        './data/memory',
        ${fileSha256},
        ${sourceContent.length},
        'pai:memory/auto',
        false, false, ${config.tenant},
        'discovered'::preserve.preservation_state
      )
      RETURNING artifact_id
    `;
    artifactId = newArtifact.artifact_id;
  }

  const result = await loadExtraction(artifactId, deterministic, null, sql, sourceContent);
  console.log(`  Entities created:  ${result.entitiesCreated}`);
  console.log(`  Facts created:     ${result.factsCreated}`);
  console.log(`  Segments created:  ${result.segmentsCreated}`);

  console.log("\n[3/3] Done.");
  await sql.end();
}

async function extractSingleIncident(
  incidentPath: string,
  opts: ExtractOpts,
): Promise<void> {
  const { config } = await import("./config");
  const { parseDeterministic } = await import("./extract/deterministic");
  const { extractSemantic } = await import("./extract/semantic");
  const { queueOversizedIncidentArtifact } = await import("./extract/oversized-artifact");
  const { LLMClient } = await import("./llm/client");
  const { loadExtraction } = await import("./extract/load");
  const { sql, testConnection } = await import("./db");
  const { basename: bn, join: jn } = await import("path");
  const { readFileSync, statSync, existsSync: exSync } = await import("fs");
  const { createHash } = await import("crypto");

  const slug = bn(incidentPath);

  console.log(`\n=== BrainCore Extract: ${slug} ===\n`);

  const notesPath = exSync(jn(incidentPath, "notes.md"))
    ? jn(incidentPath, "notes.md")
    : jn(incidentPath, "incident.md");

  let sourceContent: string;
  let fileSha256: string;
  let fileSize: number;
  try {
    sourceContent = readFileSync(notesPath, "utf-8");
    fileSha256 = createHash("sha256").update(sourceContent, "utf-8").digest("hex");
    fileSize = statSync(notesPath).size;
  } catch (e: any) {
    console.error(`  Cannot read source file: ${e.message}`);
    await sql.end();
    return;
  }

  if (fileSize > config.limits.maxSourceBytes) {
    console.log(`[1/4] Source artifact exceeds ${config.limits.maxSourceBytes} bytes. Extraction skipped.`);
    if (opts.dryRun) {
      console.log("\n[2/4] Dry run complete. No data written.");
      return;
    }

    const connected = await testConnection();
    if (!connected) {
      console.error("  Database connection failed. Cannot queue oversized artifact for review.");
      process.exit(1);
    }

    const artifactId = await queueOversizedIncidentArtifact(sql, {
      slug,
      incidentPath,
      fileSha256,
      fileSize,
      tenant: config.tenant,
    });
    console.log(`  Queued artifact ${artifactId} for human review (source_too_large).`);
    await sql.end();
    return;
  }

  console.log("[1/4] Deterministic extraction...");
  const deterministic = await parseDeterministic(incidentPath);

  console.log(`  Entities: ${deterministic.entities.length}`);
  console.log(`  Facts:    ${deterministic.facts.length}`);
  console.log(`  Segments: ${deterministic.segments.length}`);
  console.log(`  Episode:  ${deterministic.episode.title}`);
  console.log(`  Scope:    ${deterministic.scope_path}`);

  for (const fact of deterministic.facts) {
    const objDisplay =
      typeof fact.object_value === "string"
        ? fact.object_value.slice(0, 60)
        : JSON.stringify(fact.object_value);
    console.log(`  -> (${fact.subject}, ${fact.predicate}, ${objDisplay})`);
  }

  let semantic = null;
  if (!opts.skipSemantic) {
    console.log("\n[2/4] Semantic extraction...");
    const llmClient = new LLMClient();

    const segmentInputs = deterministic.segments.map((s) => ({
      id: `seg_${s.ordinal}`,
      section_label: s.section_label,
      content: s.content,
    }));

    semantic = await extractSemantic(
      segmentInputs,
      deterministic.facts,
      llmClient,
      { useClaude: opts.useClaude },
    );

    if (semantic) {
      console.log(`  Semantic facts:    ${semantic.facts.length}`);
      console.log(`  Lessons learned:   ${semantic.lessons.length}`);
      console.log(`  Open questions:    ${semantic.questions.length}`);
      console.log(`  Model:             ${semantic.provider}/${semantic.model}`);
      console.log(`  Duration:          ${semantic.durationMs}ms`);
      if (semantic.warnings.length > 0) {
        console.log("  Semantic warnings:");
        for (const warning of semantic.warnings) console.log(`    - ${warning}`);
      }
    } else {
      console.log("  Semantic extraction skipped (no LLM available).");
    }
  } else {
    console.log("\n[2/4] Semantic extraction SKIPPED (--skip-semantic)");
  }

  if (opts.dryRun) {
    console.log("\n[3/4] Database load SKIPPED (--dry-run)");
    console.log("\n[4/4] Dry run complete. No data written.");
    return;
  }

  console.log("\n[3/4] Loading into preserve schema...");
  const connected = await testConnection();
  if (!connected) {
    console.error("  Database connection failed. Cannot load extraction.");
    process.exit(1);
  }

  let artifactId: string;
  const existing = await sql`
    SELECT artifact_id FROM preserve.artifact
    WHERE source_key = ${slug}
      AND tenant = ${config.tenant}
    LIMIT 1
  `.catch(() => [] as any[]);

  if (existing.length > 0) {
    artifactId = existing[0].artifact_id;
    console.log(`  Using existing artifact: ${artifactId}`);
  } else {
    const [newArtifact] = await sql`
      INSERT INTO preserve.artifact (
        source_key, source_type, original_path, sha256, size_bytes,
        scope_path, can_query_raw, can_promote_memory, tenant,
        preservation_state
      ) VALUES (
        ${slug},
        'opsvault_incident'::preserve.source_type,
        ${incidentPath},
        ${fileSha256},
        ${fileSize},
        ${deterministic.scope_path},
        false, false, ${config.tenant},
        'discovered'::preserve.preservation_state
      )
      RETURNING artifact_id
    `.catch((e: any) => {
      console.error(`  Failed to create artifact: ${e.message}`);
      return [] as any[];
    });

    if (!newArtifact) {
      console.log("\n[4/4] Done (database load skipped, schema not ready).");
      await sql.end();
      return;
    }
    artifactId = newArtifact.artifact_id;
    console.log(`  Created artifact: ${artifactId}`);
  }

  try {
    const result = await loadExtraction(
      artifactId,
      deterministic,
      semantic,
      sql,
      sourceContent,
    );

    console.log(`  Entities created:  ${result.entitiesCreated}`);
    console.log(`  Facts created:     ${result.factsCreated}`);
    console.log(`  Segments created:  ${result.segmentsCreated}`);
    console.log(`  Episode ID:        ${result.episodeId || "none"}`);

    if (result.warnings.length > 0) {
      console.log("  Warnings:");
      for (const w of result.warnings) console.log(`    - ${w}`);
    }
  } catch (e: any) {
    console.error(`  Database load failed: ${e.message}`);
    if (e.message.includes("does not exist") || e.message.includes("column")) {
      console.error("  This may be a schema mismatch. Check preserve table definitions.");
    }
    console.error("  Deterministic extraction above is valid and can be loaded later.");
  }

  console.log("\n[4/4] Done.");
  await sql.end();
}

async function extractPendingArtifacts(
  opts: Omit<ExtractOpts, "dryRun">,
): Promise<void> {
  const { sql, testConnection } = await import("./db");

  console.log("\n=== BrainCore Extract: Pending Artifacts ===\n");

  const connected = await testConnection();
  if (!connected) {
    console.error("Database connection failed.");
    process.exit(1);
  }

  const pending = await sql`
    SELECT artifact_id, source_key, original_path, source_type::text
    FROM preserve.artifact
    WHERE tenant = ${config.tenant}
      AND can_query_raw = false
      AND source_type IN ('opsvault_incident', 'claude_session')
    ORDER BY discovered_at ASC
  `.catch((e: any) => {
    console.error(`Query failed: ${e.message}`);
    return [] as any[];
  });

  if (pending.length === 0) {
    console.log("No pending artifacts to extract.");
    await sql.end();
    return;
  }

  console.log(`Found ${pending.length} pending artifacts.\n`);

  for (const artifact of pending) {
    console.log(`--- ${artifact.source_key} ---`);
    try {
      if (artifact.source_type === "claude_session") {
        await extractSession(artifact.original_path);
      } else {
        await extractSingleIncident(artifact.original_path, {
          ...opts,
          skipSemantic: false,
        });
      }
    } catch (e: any) {
      console.error(`  FAILED: ${e.message}`);
    }
  }

  await sql.end();
}

async function extractCodexHistory(dryRun?: boolean): Promise<void> {
  const { parseCodexHistory } = await import("./extract/codex-parser");
  const { loadExtraction } = await import("./extract/load");
  const { sql, testConnection } = await import("./db");
  const { createHash } = await import("crypto");

  console.log("\n=== BrainCore Extract: Codex History ===\n");

  console.log("[1/3] Parsing Codex history + sessions...");
  const deterministic = await parseCodexHistory();
  console.log(`  Entities: ${deterministic.entities.length}`);
  console.log(`  Facts:    ${deterministic.facts.length}`);
  console.log(`  Segments: ${deterministic.segments.length}`);
  console.log(`  Episode:  ${deterministic.episode.title}`);

  if (dryRun) {
    console.log("\n[2/3] Database load SKIPPED (--dry-run)");
    console.log("\n[3/3] Dry run complete. No data written.");
    return;
  }

  console.log("\n[2/3] Loading into preserve schema...");
  const connected = await testConnection();
  if (!connected) { process.exit(1); }

  const sourceContent = JSON.stringify({ scan_date: new Date().toISOString() });
  const fileSha256 = createHash("sha256").update(sourceContent, "utf-8").digest("hex");
  const sourceKey = `codex-history-scan:${new Date().toISOString().split("T")[0]}`;

  let artifactId: string;
  const [existing] = await sql`
    SELECT artifact_id FROM preserve.artifact
    WHERE source_key = ${sourceKey}
      AND tenant = ${config.tenant}
    LIMIT 1
  `.catch(() => [] as any[]);

  if (existing) {
    artifactId = existing.artifact_id;
  } else {
    const [newArtifact] = await sql`
      INSERT INTO preserve.artifact (
        source_key, source_type, original_path, sha256, size_bytes,
        scope_path, can_query_raw, can_promote_memory, tenant,
        preservation_state
      ) VALUES (
        ${sourceKey},
        'codex_session'::preserve.source_type,
        './data/codex',
        ${fileSha256},
        ${sourceContent.length},
        'codex:history',
        false, false, ${config.tenant},
        'discovered'::preserve.preservation_state
      )
      RETURNING artifact_id
    `;
    artifactId = newArtifact.artifact_id;
  }

  const result = await loadExtraction(artifactId, deterministic, null, sql, sourceContent);
  console.log(`  Entities created:  ${result.entitiesCreated}`);
  console.log(`  Facts created:     ${result.factsCreated}`);
  console.log(`  Segments created:  ${result.segmentsCreated}`);

  console.log("\n[3/3] Done.");
  await sql.end();
}

async function extractCodexShared(dryRun?: boolean): Promise<void> {
  const { parseCodexShared } = await import("./extract/codex-shared-parser");
  const { loadExtraction } = await import("./extract/load");
  const { sql, testConnection } = await import("./db");
  const { createHash } = await import("crypto");

  console.log("\n=== BrainCore Extract: CODEX_SHARED Memory ===\n");

  console.log("[1/3] Parsing CODEX_SHARED structure...");
  const deterministic = await parseCodexShared();
  console.log(`  Entities: ${deterministic.entities.length}`);
  console.log(`  Facts:    ${deterministic.facts.length}`);
  console.log(`  Segments: ${deterministic.segments.length}`);
  console.log(`  Episode:  ${deterministic.episode.title}`);

  if (dryRun) {
    console.log("\n[2/3] Database load SKIPPED (--dry-run)");
    console.log("\n[3/3] Dry run complete. No data written.");
    return;
  }

  console.log("\n[2/3] Loading into preserve schema...");
  const connected = await testConnection();
  if (!connected) { process.exit(1); }

  const sourceContent = JSON.stringify({ scan_date: new Date().toISOString() });
  const fileSha256 = createHash("sha256").update(sourceContent, "utf-8").digest("hex");
  const sourceKey = `codex-shared-scan:${new Date().toISOString().split("T")[0]}`;

  let artifactId: string;
  const [existing] = await sql`
    SELECT artifact_id FROM preserve.artifact
    WHERE source_key = ${sourceKey}
      AND tenant = ${config.tenant}
    LIMIT 1
  `.catch(() => [] as any[]);

  if (existing) {
    artifactId = existing.artifact_id;
  } else {
    const [newArtifact] = await sql`
      INSERT INTO preserve.artifact (
        source_key, source_type, original_path, sha256, size_bytes,
        scope_path, can_query_raw, can_promote_memory, tenant,
        preservation_state
      ) VALUES (
        ${sourceKey},
        'codex_shared'::preserve.source_type,
        './data/codex-shared',
        ${fileSha256},
        ${sourceContent.length},
        'codex:shared',
        false, false, ${config.tenant},
        'discovered'::preserve.preservation_state
      )
      RETURNING artifact_id
    `;
    artifactId = newArtifact.artifact_id;
  }

  const result = await loadExtraction(artifactId, deterministic, null, sql, sourceContent);
  console.log(`  Entities created:  ${result.entitiesCreated}`);
  console.log(`  Facts created:     ${result.factsCreated}`);
  console.log(`  Segments created:  ${result.segmentsCreated}`);

  console.log("\n[3/3] Done.");
  await sql.end();
}


async function extractDiscord(dryRun?: boolean): Promise<void> {
  const { parseDiscordSummaries } = await import("./extract/discord-parser");
  const { loadExtraction } = await import("./extract/load");
  const { sql, testConnection } = await import("./db");
  const { createHash } = await import("crypto");

  console.log("\n=== BrainCore Extract: Discord Digest ===\n");

  console.log("[1/3] Parsing Discord micro_summaries...");
  const deterministic = parseDiscordSummaries();
  console.log(`  Entities: ${deterministic.entities.length}`);
  console.log(`  Facts:    ${deterministic.facts.length}`);
  console.log(`  Segments: ${deterministic.segments.length}`);
  console.log(`  Episode:  ${deterministic.episode.title}`);

  if (dryRun) {
    console.log("\n[2/3] Database load SKIPPED (--dry-run)");
    console.log("\n[3/3] Dry run complete. No data written.");
    return;
  }

  console.log("\n[2/3] Loading into preserve schema...");
  const connected = await testConnection();
  if (!connected) { process.exit(1); }

  const sourceContent = JSON.stringify({
    scan_date: new Date().toISOString(),
    summary_count: deterministic.segments.length,
  });
  const fileSha256 = createHash("sha256").update(sourceContent, "utf-8").digest("hex");
  const sourceKey = `discord-digest-scan:${new Date().toISOString().split("T")[0]}`;

  let artifactId: string;
  const [existing] = await sql`
    SELECT artifact_id FROM preserve.artifact
    WHERE source_key = ${sourceKey}
      AND tenant = ${config.tenant}
    LIMIT 1
  `.catch(() => [] as any[]);

  if (existing) {
    artifactId = existing.artifact_id;
    console.log(`  Using existing artifact: ${artifactId}`);
  } else {
    const [newArtifact] = await sql`
      INSERT INTO preserve.artifact (
        source_key, source_type, original_path, sha256, size_bytes,
        scope_path, can_query_raw, can_promote_memory, tenant,
        preservation_state
      ) VALUES (
        ${sourceKey},
        'discord_conversation'::preserve.source_type,
        './data/discord-digest.db',
        ${fileSha256},
        ${sourceContent.length},
        'discord:digest',
        false, false, ${config.tenant},
        'discovered'::preserve.preservation_state
      )
      RETURNING artifact_id
    `;
    artifactId = newArtifact.artifact_id;
    console.log(`  Created artifact: ${artifactId}`);
  }

  const result = await loadExtraction(artifactId, deterministic, null, sql, sourceContent);
  console.log(`  Entities created:  ${result.entitiesCreated}`);
  console.log(`  Facts created:     ${result.factsCreated}`);
  console.log(`  Segments created:  ${result.segmentsCreated}`);

  console.log("\n[3/3] Done.");
  await sql.end();
}
// ── Dispatch ─────────────────────────────────────────────────────────────────

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error("");
  printUsage();
  process.exit(1);
}

// -- Telegram Chat Extraction --------------------------------------------------

async function extractTelegram(dryRun?: boolean): Promise<void> {
  const { parseTelegramChat } = await import("./extract/telegram-parser");
  const { loadExtraction } = await import("./extract/load");
  const { sql, testConnection } = await import("./db");
  const { createHash } = await import("crypto");

  console.log("\n=== BrainCore Extract: Telegram Chat ===\n");

  console.log("[1/3] Polling Telegram for new messages...");
  const { result: deterministic, stats } = await parseTelegramChat(dryRun);
  console.log(`  Updates processed:     ${stats.updatesProcessed}`);
  console.log(`  Messages stored:       ${stats.messagesStored}`);
  console.log(`  Substantial messages:  ${stats.substantialMessages}`);
  console.log(`  Entities: ${deterministic.entities.length}`);
  console.log(`  Facts:    ${deterministic.facts.length}`);
  console.log(`  Segments: ${deterministic.segments.length}`);

  if (dryRun) {
    console.log("\n[2/3] Database load SKIPPED (--dry-run)");
    if (deterministic.facts.length > 0) {
      console.log("\n  Sample facts that would be created:");
      for (const fact of deterministic.facts.slice(0, 5)) {
        const obj = typeof fact.object_value === "string"
          ? fact.object_value.slice(0, 80)
          : JSON.stringify(fact.object_value).slice(0, 80);
        console.log(`    [${fact.fact_kind}] ${fact.subject}.${fact.predicate} = ${obj}...`);
      }
    }
    console.log("\n[3/3] Dry run complete. No data written.");
    return;
  }

  if (deterministic.facts.length === 0) {
    console.log("\n  No substantial messages to extract. Skipping DB load.");
    return;
  }

  console.log("\n[2/3] Loading into preserve schema...");
  const connected = await testConnection();
  if (!connected) { process.exit(1); }

  const sourceContent = JSON.stringify({
    scan_date: new Date().toISOString(),
    messages: stats.messagesStored,
    substantial: stats.substantialMessages,
  });
  const fileSha256 = createHash("sha256").update(sourceContent, "utf-8").digest("hex");
  const sourceKey = `telegram-chat-scan:${new Date().toISOString().split("T")[0]}`;

  let artifactId: string;
  const [existing] = await sql`
    SELECT artifact_id FROM preserve.artifact
    WHERE source_key = ${sourceKey}
      AND tenant = ${config.tenant}
    LIMIT 1
  `.catch(() => [] as any[]);

  if (existing) {
    artifactId = existing.artifact_id;
    console.log(`  Using existing artifact: ${artifactId}`);
  } else {
    const [newArtifact] = await sql`
      INSERT INTO preserve.artifact (
        source_key, source_type, original_path, sha256, size_bytes,
        scope_path, can_query_raw, can_promote_memory, tenant,
        preservation_state
      ) VALUES (
        ${sourceKey},
        'telegram_chat'::preserve.source_type,
        './data/telegram-history.jsonl',
        ${fileSha256},
        ${sourceContent.length},
        'telegram:chat/pai',
        false, false, ${config.tenant},
        'discovered'::preserve.preservation_state
      )
      RETURNING artifact_id
    `;
    artifactId = newArtifact.artifact_id;
    console.log(`  Created artifact: ${artifactId}`);
  }

  const result = await loadExtraction(artifactId, deterministic, null, sql, sourceContent);
  console.log(`  Entities created:  ${result.entitiesCreated}`);
  console.log(`  Facts created:     ${result.factsCreated}`);
  console.log(`  Segments created:  ${result.segmentsCreated}`);

  console.log("\n[3/3] Done.");
  await sql.end();
}

// -- Grafana Alert Extraction -------------------------------------------------

async function extractGrafana(dryRun?: boolean): Promise<void> {
  const { parseGrafanaAlerts } = await import("./extract/grafana-parser");
  const { loadExtraction } = await import("./extract/load");
  const { sql, testConnection } = await import("./db");
  const { createHash } = await import("crypto");

  console.log("\n=== BrainCore Extract: Grafana Alerts ===\n");

  // Load existing incidents for correlation
  let incidents: any[] = [];
  try {
    const connected = await testConnection();
    if (connected) {
      incidents = await sql`
        SELECT e.entity_id, e.canonical_name,
               ep.start_at, ep.end_at
        FROM preserve.entity e
        LEFT JOIN preserve.episode ep ON ep.scope_path LIKE '%' || e.canonical_name || '%'
        WHERE e.tenant = ${config.tenant}
          AND e.entity_type = 'incident'
        ORDER BY ep.start_at DESC NULLS LAST
        LIMIT 100
      `;
      console.log(`  Loaded ${incidents.length} incidents for correlation`);
    }
  } catch (e: any) {
    console.log(`  Could not load incidents for correlation: ${e.message}`);
  }

  console.log("[1/3] Polling Grafana for alert annotations...");
  const { result: deterministic, stats } = await parseGrafanaAlerts(incidents, dryRun);
  console.log(`  Annotations found:  ${stats.annotationsFound}`);
  console.log(`  New annotations:    ${stats.newAnnotations}`);
  console.log(`  Alert facts:        ${stats.alertFacts}`);
  console.log(`  Correlations:       ${stats.correlations}`);
  console.log(`  Entities: ${deterministic.entities.length}`);
  console.log(`  Facts:    ${deterministic.facts.length}`);
  console.log(`  Segments: ${deterministic.segments.length}`);

  if (dryRun) {
    console.log("\n[2/3] Database load SKIPPED (--dry-run)");
    if (deterministic.facts.length > 0) {
      console.log("\n  Sample facts that would be created:");
      for (const fact of deterministic.facts.slice(0, 5)) {
        const obj = typeof fact.object_value === "string"
          ? fact.object_value.slice(0, 80)
          : JSON.stringify(fact.object_value).slice(0, 80);
        console.log(`    [${fact.fact_kind}] ${fact.subject}.${fact.predicate} = ${obj}...`);
      }
    }
    console.log("\n[3/3] Dry run complete. No data written.");
    if (sql) await sql.end().catch(() => {});
    return;
  }

  if (deterministic.facts.length === 0) {
    console.log("\n  No new alert annotations to extract. Skipping DB load.");
    if (sql) await sql.end().catch(() => {});
    return;
  }

  console.log("\n[2/3] Loading into preserve schema...");
  const connected2 = await testConnection();
  if (!connected2) { process.exit(1); }

  const sourceContent = JSON.stringify({
    scan_date: new Date().toISOString(),
    annotations: stats.annotationsFound,
    newAnnotations: stats.newAnnotations,
    correlations: stats.correlations,
  });
  const fileSha256 = createHash("sha256").update(sourceContent, "utf-8").digest("hex");
  const sourceKey = `grafana-alerts-scan:${new Date().toISOString().split("T")[0]}`;

  let artifactId: string;
  const [existing] = await sql`
    SELECT artifact_id FROM preserve.artifact
    WHERE source_key = ${sourceKey}
      AND tenant = ${config.tenant}
    LIMIT 1
  `.catch(() => [] as any[]);

  if (existing) {
    artifactId = existing.artifact_id;
    console.log(`  Using existing artifact: ${artifactId}`);
  } else {
    const [newArtifact] = await sql`
      INSERT INTO preserve.artifact (
        source_key, source_type, original_path, sha256, size_bytes,
        scope_path, can_query_raw, can_promote_memory, tenant,
        preservation_state
      ) VALUES (
        ${sourceKey},
        'monitoring_alert'::preserve.source_type,
        'grafana:alerts/localhost:3010',
        ${fileSha256},
        ${sourceContent.length},
        'monitoring:grafana/alerts',
        false, false, ${config.tenant},
        'discovered'::preserve.preservation_state
      )
      RETURNING artifact_id
    `;
    artifactId = newArtifact.artifact_id;
    console.log(`  Created artifact: ${artifactId}`);
  }

  const result = await loadExtraction(artifactId, deterministic, null, sql, sourceContent);
  console.log(`  Entities created:  ${result.entitiesCreated}`);
  console.log(`  Facts created:     ${result.factsCreated}`);
  console.log(`  Segments created:  ${result.segmentsCreated}`);

  console.log("\n[3/3] Done.");
  await sql.end();
}

await commands[command]();
