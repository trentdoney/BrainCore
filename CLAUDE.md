# CLAUDE.md — BrainCore

**Read this first when working on BrainCore.**

## Quick Context

BrainCore is an autonomous memory system. It ingests operational artifacts from 7+ source types, extracts structured facts with provenance via LLM, compiles patterns/playbooks, and exposes queryable memory via MCP.

**Full architecture:** `README.md`
**Agent-facing docs:** `AGENTS.md`
**Security posture:** `SECURITY.md`
**Install guide:** `SETUP.md`

## Prime Directives

1. **This is a PUBLIC repo.** Every commit gets scrutinized. Run the sanitization check before `git push` (see AGENTS.md).
2. **Secrets live in `.env`**, never in code. `.env` is gitignored.
3. **Archive first, extract second.** Never let preservation depend on LLM readiness.
4. **Trust classes are load-bearing.** Only deterministic, corroborated_llm, and human_curated facts can form patterns. Single-source LLM facts are searchable but cannot compound into false knowledge.
5. **TypeScript writes, Python reads.** Dont cross the streams.

## Files You Must NOT Break

- `src/config.ts` — pure env-var, zero hardcoded values
- `src/extract/load.ts` — single transaction per artifact, rollback on failure
- `src/extract/quality-gate.ts` — fingerprint dedup, per-source validation
- `mcp/memory_search.py` — 4-stream RRF retrieval with priority boost + tenant filter
- `cron/nightly.sh` — parallel groups with flock + DRY_RUN + failure isolation
- `sql/001_preserve_schema.sql` — 12 tables, 71+ indexes, the foundation

## Workflow

### Making Changes
```bash
# 1. Edit files in-place
vim src/extract/load.ts

# 2. Type-check
bun x tsc --noEmit

# 3. Dry-run test (if you touched cron/)
DRY_RUN=1 bash cron/nightly.sh

# 4. Live test (if you touched extractors)
bun src/cli.ts extract --incident /path/to/test/incident

# 5. Run sanitization gates (see AGENTS.md)

# 6. Commit + push
git add -A
git commit -m "Descriptive message"
git push origin main
```

### Schema Changes
1. Write migration at `sql/006_your_change.sql` (idempotent: IF NOT EXISTS, DO blocks)
2. Apply via psql against your configured PostgreSQL host
3. Write backfill script at `scripts/backfill-your-change.py`
4. Run backfill
5. Update `src/extract/load.ts` to populate new column on new inserts
6. Update `mcp/memory_search.py` if retrieval needs the new column

### Debugging the Pipeline
```bash
# Current nightly log (paths from BRAINCORE_LOG_DIR env var)
tail -f "$BRAINCORE_LOG_DIR/nightly-$(date +%Y%m%d).log"

# Failed steps from last run
cat "$BRAINCORE_LOG_DIR/nightly-failures-$(date +%Y%m%d)"

# Manual run with full output
bash cron/nightly.sh 2>&1 | tee /tmp/manual-run.log

# Check fact counts
bun src/cli.ts maintenance --stats
```

## Architecture Notes

### Where Components Run (Typical Deployment)

BrainCore is typically deployed across two machines:
- **Services machine**: runs BrainCore CLI, cron, MCP FastAPI server
- **Database/GPU machine**: runs PostgreSQL + pgvector and optional vLLM

Single-machine deployments also work — set all `BRAINCORE_*` env vars to point to localhost.

### Separation of Concerns

- **`src/` (TypeScript)** owns all write paths: scan, archive, extract, load, consolidate, publish
- **`mcp/` (Python)** owns the read path: 4-stream hybrid retrieval, FastAPI endpoints
- **Shared state via PostgreSQL only** — no direct inter-process calls
- **Embeddings via HTTP** — TypeScript does not load ML models

## Common Mistakes

1. **Hardcoding paths** — All paths must come from `config.ts`. If you find yourself typing absolute paths, stop and add a config field.
2. **Bypassing the quality gate** — Every insert goes through `checkQualityGate()`. Dont skip it.
3. **Single-source LLM facts forming patterns** — The consolidator filters these out. Dont re-enable them without corroboration logic.
4. **Forgetting the flock** — Without `nightly.lock`, overlapping cron runs corrupt state.
5. **Pushing with secrets** — Run the sanitization gates BEFORE every commit. Never trust that `.env` is the only place with secrets.
6. **The `mcp/memory_search.py` in this repo is a reference copy** — in production deployments it lives alongside the FastAPI server. Sync both if you change retrieval logic.

## Session Patterns

- **Bulk operations** → background/fast-model workers for throughput
- **Planning** → peer-review target 9/10+ before executing big changes
- **Parallel work** → multiple workers in parallel where tasks are independent
- **Testing** → dry-run first, then live
- **Alerts** → use your configured Telegram bot (`BRAINCORE_TELEGRAM_*` env vars)

## Pre-Push Checklist

Before `git push origin main`:
- [ ] All tests pass (`bun x tsc --noEmit`)
- [ ] Dry-run cron works (if cron touched)
- [ ] Sanitization gates empty
- [ ] `.env` not staged
- [ ] Commit message describes WHAT and WHY
