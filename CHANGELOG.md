# Changelog

All notable changes to BrainCore are documented in this file. This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.5] — 2026-04-10

Dependency maintenance release. This version updates Zod to v4 and locks Bun dependency resolution for reproducible CI installs.

### Added
- `bun.lock` is now committed so `bun install --frozen-lockfile` resolves dependencies reproducibly in local and GitHub Actions environments.
- Targeted Bun tests for LLM extraction validation under Zod v4.

### Changed
- `zod` upgraded from v3 to v4.
- `FactSchema.object_value` now declares explicit string keys for record-shaped fact values, matching Zod v4's `z.record(keySchema, valueSchema)` signature.

### Fixed
- TypeScript validation now passes with Zod v4 for object-valued semantic facts.

### Removed
- None.

## [1.1.4] — 2026-04-09

Public launch hardening release. This version makes the repository self-contained for first-time setup, aligns the open-source schema with the shipped CLI and evaluation flows, and prepares the repo for a clean public release.

### Added
- **Example MCP server** (`examples/mcp_server/`): minimal reference implementation that imports from `mcp/memory_search.py` and exposes the retrieval tool via FastMCP, with a `README.md`, `requirements.txt`, and smoke-runnable entrypoint.
- **Migration 006** (`sql/006_source_type_values.sql`): idempotent `ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS` statements for every source type inserted by `src/cli.ts` (`claude_plan`, `claude_session`, `codex_session`, `codex_shared`, `config_diff`, `device_log`, `discord_conversation`, `monitoring_alert`, `opsvault_incident`, `pai_memory`, `project_doc`, `telegram_chat`).
- **Migration 007** (`sql/007_eval_run.sql`): creates `preserve.eval_run` table referenced by `bun src/cli.ts eval --run` and `src/eval/runner.ts`. Columns match the INSERT shape in `runner.ts` and the SELECT shape in `cli.ts`.
- **Migration 008** (`sql/008_eval_case.sql`): creates `preserve.eval_case` gold-set table referenced by `src/eval/gold.ts:loadGoldSet` and iterated by `src/eval/runner.ts:runEval`. Columns (`eval_case_id`, `artifact_id`, `gold_labels`, `notes`, `source_type`, `created_at`) match the shipped evaluation path, with indexes on `created_at` and `artifact_id`. This brings the preserve table count to **14**.
- **`preserve.project_service_map`** inline `CREATE TABLE IF NOT EXISTS` added to the patched `sql/004_seed_projects.example.sql`. The table is referenced by `004`'s seed INSERTs and is now available in the example project scaffold.
- **`mcp/__init__.py`** + **`mcp/embedder.py`**: make the repo-root `mcp/` directory a proper Python package and provide a zero-vector HTTP embedder stub so `from mcp.memory_search import ...` resolves on fresh clones.
- **`sql/001_preserve_schema.sql` bootstrap patch**: prepends `CREATE SCHEMA IF NOT EXISTS preserve; CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;` so a first-time clone on a fresh pgvector/pg16 container runs the full migration set without manual schema prep.
- **`CHANGELOG.md`** (this file): Keep-a-Changelog scaffold reconstructed from `git log v1.0.0..HEAD` with Added / Changed / Fixed / Removed subsections per release.
- **Reproducible benchmark harness** under `benchmarks/`: `run_retrieval.py` (12-query canonical runner with auto-seed from `seed_smoke.sql`), `run_grounding.py` (direct-SQL `fact_evidence` rate), `seed_smoke.sql` (synthetic pipeline-regression fixture, honestly framed as circular), `canonical_queries.yaml`, `claims-to-evidence.yaml` (smoke-regression vs production-corpus framing), `verify_tool_index.py` and `verify_claims_to_evidence.py` (self-test gates). These provide the pipeline-regression signal; all README headline retrieval metrics come from a separate production-corpus benchmark committed in a later follow-up.
- **Launch hardening tests** under `tests/`: six pytest cases exercising the migration deltas (`test_migrations.py` — enum count, `eval_run` existence, preserve table count, `project_service_map` existence) and module import health (`test_status.py`).
- **Bun smoke test** at `src/__tests__/smoke.test.ts`: two TypeScript cases that import the CLI entrypoint without crashing on missing env vars (stubs `BRAINCORE_POSTGRES_DSN` before dynamic import to avoid the db.ts eager-load finding).

### Changed
- **`package.json` version** bumped from `1.0.0` to `1.1.4` to match the tag history.

### Fixed
- `preserve.eval_case` is now created by migration `sql/008_eval_case.sql`, so `bun src/cli.ts eval --run` works on a fresh clone without manual schema patching.

### Removed
- None.

## [1.1.3] — 2026-04-09

Public repository hardening release. This pass tightens the docs, automation, and public setup surface before the GitHub launch.

### Added
- README.md Quick Start rewritten as 8 end-to-end steps runnable against `examples/sample-vault/`.
- README.md CLI Commands section now documents every subcommand dispatched by `src/cli.ts`: `eval --report`, `project tag`, `project summary`, `maintenance --stats`, `migrate`, `extract --telegram`, `extract --grafana`, `extract --pai-memory`, `--dry-run`, `--use-claude`, `--skip-semantic`, `publish-notes --scope`, `project archive --reason`, and the `help` / `--help` / `-h` variants.
- Explicit `--help` / `-h` / `help` / no-args handler in `src/cli.ts` that runs **before** the commands map lookup and exits `0` cleanly.

### Changed
- `src/cli.ts`: extracted `printUsage()` helper; simplified unknown-command dispatch to `stderr` + usage + `exit 1`.
- `src/config.ts`: converted from eager object literal to lazy `Proxy` + memoized `buildConfig()`. `requiredEnv()` calls now fire on first property access, not on module load, so `bun src/cli.ts --help` works on fresh clones without a `.env` file.
- README.md: nightly pipeline phrase updated from "19-step" (v1.0.0 era) to "multi-step parallel".
- README.md: corrected signatures for `project merge <src> --into <tgt>` and `project fork <parent> --into <child1> <child2>`.
- `SETUP.md` Docker quick-start: replaced the no-op self-referential DSN export with an actionable `cp .env.example .env` + `$EDITOR .env` + `set -a && . ./.env && set +a` flow. DSN placeholder uses `$`-prefixed segments throughout to satisfy the Gate 8 sanitization pattern.

### Fixed
- `bun src/cli.ts --help` on a sterile env (`env -i ... BRAINCORE_BOOTSTRAP=1`) now exits `0` instead of crashing on missing env vars.

### Removed
- None.

## [1.1.2] — 2026-04-09

Session 4 finalization. Nightly cron cleanup, monitoring-alert pipeline fixes for Grafana 11.2 annotation drift, and the first cut of the 8-gate pre-push sanitization script.

### Added
- `scripts/pre-push-gate.sh`: 8-gate pre-push sanitization check covering host paths, DSN fallbacks, secrets, PII, and chat IDs.
- `parseUnifiedAlertingText()` regex extractor and `normalizeAnnotation()` normalizer in `src/extract/grafana-parser.ts` to handle the Grafana 11.2 Unified Alerting annotation shape drift (labels now embedded in `annotation.text` as `{key=value,...}` instead of structured `tags[]`).
- Optional `metadata?` field on the `Fact` interface in `src/extract/deterministic.ts`.
- `BRAINCORE_PYTHON` env-var support in `cron/nightly.sh` (unblocks the embeddings step).
- `BRAINCORE_DISCORD_DB_PATH` and `BRAINCORE_CODEX_SHARED_DIR` env vars with graceful skip when unset.
- `.nightly.lock` added to `.gitignore`.

### Changed
- `src/extract/grafana-parser.ts`: fact builder prefers `labels.service` / `labels.severity`; filters service entities to meaningful keys. Every `monitoring_alert` fact now carries metadata `{ service, severity, labels, alert_id }`.
- `src/load.ts`: metadata forwarding fixed for quality-gate validation.
- `src/quality-gate.ts`: `validateMonitoringAlert` now reads `service` / `severity` via a `fact.metadata` → `object_value` → fact-itself → `ctx.metadata` chain.
- `AGENTS.md`: full rewrite. Removed the self-matching gate regex block, removed stale `scanner.ts` references, removed host-specific references, updated directory layout to reflect reality.
- `SETUP.md`: replaced literal DSN examples with `$BRAINCORE_POSTGRES_DSN` env var references.
- `src/config.ts`: removed literal DSN fallback; requires env var (fail-fast).
- `scripts/backfill-embeddings.py`, `scripts/backfill-temporal.py`, `scripts/bulk-archive.py`, `scripts/retag-milestones.py`, `scripts/retag-projects.py`: removed literal DSN fallbacks; require env var; fail-fast on missing config.

### Fixed
- `src/extract/telegram-parser.ts`: `const` shadow at line 351.
- `cron/nightly.sh`: removed orphaned `scan` / `replicate` / `archive-session` commands that referenced `scanner.ts` modules that never existed.
- `src/extract/discord-parser.ts`: rewired to use `BRAINCORE_DISCORD_DB_PATH` env var with graceful skip.
- `src/extract/codex-shared-parser.ts`: rewired to use `BRAINCORE_CODEX_SHARED_DIR` env var.
- Nightly cron: full live pass now completes with 0 unexpected failures (was 5 before Session 4). 26,966 facts persisted.
- `bash scripts/pre-push-gate.sh`: ALL 8 GATES PASS, exit 0.

### Removed
- Orphaned `scan` / `replicate` / `archive-session` commands from `cron/nightly.sh`.
- Literal DSN fallbacks from `src/config.ts` and backfill scripts.
- Self-matching gate regex block and stale `scanner.ts` references from `AGENTS.md`.

## [1.1.1] — 2026-04-09

Sync-only release. Fixes drift between production and the public `mcp/` copy of `memory_search.py` — production had been updated during v1.1.0 but the public repo copy was missed.

### Added
- None.

### Changed
- `mcp/memory_search.py`: 11 `SELECT` queries now filter by `tenant`.
- `mcp/memory_search.py`: priority boost in `_ScoredCandidate` computed as `(11 - priority) / 5.0`.
- Default tenant is `default` in the public repo.

### Fixed
- Public `mcp/memory_search.py` drift — production tenant filter + priority boost are now present in the public copy.

### Removed
- None.

## [1.1.0] — 2026-04-09

Platform release focused on pipeline parallelism, priority scoring, and tenant-aware writes.

### Added
- **Phase 1 — Pipeline parallelism:** `cron/nightly.sh` rewritten with 5 groups (`A ingest | B archive | C extract | D post | E finalize`), `set -uo pipefail` (no `-e`) for partial success, `run_step` wrapper that captures failures without aborting, flock-based overlap protection, and a `DRY_RUN` mode for safe testing.
- Telegram alerts now include failed step names.
- `BRAINCORE_CODEX_SYNC_SRC` / `BRAINCORE_CODEX_SYNC_DEST` env vars gate the `codex-sync` step (removes hardcoded host paths).
- `BRAINCORE_PYTHON` env var (default `python3`) makes the Python interpreter configurable.
- **Phase 2 — Priority flags:** `sql/005_priority_tenant.sql` adds `priority INTEGER` (CHECK 1..10, default 5) on `artifact`, `fact`, and `memory`, with partial indexes on `priority <= 3` (hot path).
- `computePriority` helper in `src/load.ts`: milestone=1, critical=2, corroborated_llm=3, deterministic=4.
- `scripts/backfill-priority.py`: classifier that backfilled 1,194 milestones → P1, 1,501 corroborated → P3, 16,279 deterministic → P4 on the live DB.
- **Phase 3 — Tenant scoping:** `sql/005_priority_tenant.sql` adds `tenant` column on `entity`, `artifact`, `fact`, `segment`, `memory`, `episode` (default `default`).
- `BRAINCORE_TENANT` env var in `src/config.ts`.
- `src/load.ts`: `tenant` propagated to all 6 INSERT sites.
- `scripts/backfill-tenant.py`: parameterized by `BRAINCORE_TENANT` env var.

### Changed
- `cron/nightly.sh`: full rewrite (see Added).
- `src/load.ts`: every INSERT site now includes tenant and priority.

### Fixed
- Partial-success behavior in nightly cron (previous `set -e` caused early abort on transient failures).

### Removed
- Hardcoded host paths in `codex-sync` step of `cron/nightly.sh`.

### Known Follow-ups
- `mcp/memory_search.py` tenant filter + priority boost were drafted in incident notes but not yet on disk at the v1.1.0 cut. Landed in v1.1.1.

## [1.0.0] — 2026-04-08

Initial public release. BrainCore — autonomous memory system for AI infrastructure.

### Added
- 7 data source parsers: incidents, Claude sessions, Codex sessions, Discord, Telegram, Grafana, PAI.
- 4-stream hybrid retrieval (SQL + FTS + vector + temporal) with RRF fusion.
- Trust classes: deterministic, corroborated LLM, single-source LLM, human-curated.
- 15 MCP tools for memory search, state-at-time, timeline, explain, and milestones.
- Project lifecycle management: `archive`, `merge`, `fork`.
- 19-step autonomous nightly pipeline (`cron/nightly.sh`).
- Quality gate with fingerprint-based dedup.
- Local-first LLM dispatch with Claude CLI auto-fallback.
- PostgreSQL + pgvector knowledge graph: 12 tables in the `preserve` schema, 71+ indexes.
- MIT License (`1e790cf`).
- Initial commit (`6b8c589`).

### Changed
- N/A — initial release.

### Fixed
- N/A — initial release.

### Removed
- N/A — initial release.

[1.1.4]: https://github.com/trentdoney/BrainCore/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/trentdoney/BrainCore/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/trentdoney/BrainCore/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/trentdoney/BrainCore/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/trentdoney/BrainCore/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/trentdoney/BrainCore/releases/tag/v1.0.0
