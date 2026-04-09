# AGENTS.md — BrainCore

**Instructions for AI agents working in the BrainCore codebase.**

## What BrainCore Is

An autonomous memory system for AI infrastructure. It archives operational artifacts (incidents, AI sessions, Discord digests, etc.), extracts structured facts with provenance via LLM, compiles patterns and playbooks, and serves queryable memory via MCP.

**Full overview:** See `README.md`
**Architecture:** `src/` (TypeScript/Bun) for writes, `mcp/` (Python) for reads
**License:** MIT

## Directory Layout

```
BrainCore/
├── src/                 # TypeScript — owns WRITES
│   ├── cli.ts           # Main CLI entry point
│   ├── config.ts        # Pure env-var config (NO hardcoded values)
│   ├── db.ts            # postgres.js connection
│   ├── extract/         # Deterministic + semantic extractors
│   │   ├── deterministic.ts    # Rule-based parsing
│   │   ├── semantic.ts         # LLM extraction
│   │   ├── load.ts             # DB insertion with priority/tenant
│   │   ├── quality-gate.ts     # Dedup + per-source validation
│   │   ├── verify.ts           # Zod validation
│   │   ├── project-resolver.ts # Service→project mapping
│   │   ├── discord-parser.ts
│   │   ├── telegram-parser.ts
│   │   ├── grafana-parser.ts
│   │   ├── codex-parser.ts
│   │   ├── codex-shared-parser.ts
│   │   ├── pai-parser.ts
│   │   └── session-parser.ts
│   ├── consolidate/     # Pattern/playbook compilation
│   │   ├── patterns.ts
│   │   ├── playbooks.ts
│   │   ├── importance.ts
│   │   └── updater.ts
│   ├── llm/             # Client with auto-fallback
│   │   ├── client.ts
│   │   ├── health.ts
│   │   └── prompts/
│   ├── project/         # Archive/merge/fork operations
│   │   ├── archive.ts
│   │   ├── merge.ts
│   │   └── fork.ts
│   ├── publish/         # Markdown note publisher
│   │   └── markdown.ts
│   ├── security/        # Secret scanner
│   │   └── secret-scanner.ts
│   └── eval/            # Evaluation harness
│       ├── runner.ts
│       ├── gold.ts
│       ├── metrics.ts
│       └── types.ts
├── mcp/                 # Python — MCP layer (read-only)
│   ├── memory_models.py # Pydantic models
│   ├── memory_search.py # 4-stream hybrid retrieval with priority boost + tenant filter
│   ├── requirements.txt
│   └── README.md
├── sql/                 # Schema migrations
│   ├── 001_preserve_schema.sql
│   ├── 003_seed_entities.sql
│   ├── 004_seed_projects.example.sql
│   └── 005_priority_tenant.sql
├── scripts/             # Python backfill + bulk ops
│   ├── backfill-embeddings.py
│   ├── backfill-priority.py
│   ├── backfill-tenant.py
│   ├── backfill-temporal.py
│   ├── retag-projects.py
│   ├── retag-milestones.py
│   ├── bulk-archive.sh
│   ├── bulk-extract.sh
│   ├── bulk-semantic.sh
│   ├── retrieval-benchmark.py
│   ├── smoke-test.sh
│   └── pre-push-gate.sh
├── cron/
│   ├── nightly.sh       # Parallel pipeline with flock + DRY_RUN + failure isolation
│   └── archive-session.sh
├── examples/
│   ├── docker-compose.yml   # PostgreSQL + pgvector
│   ├── crontab-example
│   ├── seed-projects.sql
│   └── sample-vault/        # Fictional incidents for smoke testing
├── .env                 # SECRETS — gitignored, 0600 perms, NEVER commit
├── .env.example         # Documented template
├── README.md            # User-facing docs
├── AGENTS.md            # THIS FILE
├── CLAUDE.md            # Claude Code instructions
├── SECURITY.md          # Security posture
└── SETUP.md             # Installation guide
```

## Language Boundary

- **TypeScript (Bun) owns WRITES**: archive, extract, consolidate, publish, project lifecycle
- **Python owns READS**: MCP tools, retrieval queries (memory_search.py), embeddings
- **All shared state through PostgreSQL** — no direct inter-process calls
- **Embeddings via HTTP**: TypeScript calls the FastAPI `/embed` endpoint, does not load models in Bun

## Key Design Principles

1. **Archive first, extract second** — raw artifacts compressed and checksummed before any LLM touches them
2. **Three lifecycle states** on artifacts: `can_evict_hot`, `can_query_raw`, `can_promote_memory` (independent)
3. **Trust classes** on facts: `deterministic`, `corroborated_llm`, `single_source_llm`, `human_curated`, `retired`
4. **Only trusted facts form patterns** — single_source_llm can be searched but cannot promote to L3 knowledge
5. **Temporal validity** on all facts — `valid_from`/`valid_to` enable point-in-time queries
6. **Project identity via FK**, not string matching — `project_entity_id` is source of truth, `scope_path` is derived
7. **Priority flags** (1-10) weight retrieval and preserve high-value items from decay
8. **Tenant scoping** for multi-context isolation
9. **Evidence anchors** survive re-extraction (source_sha256, line ranges, excerpt_hash)
10. **Failure isolation** — nightly cron captures per-step failures without aborting pipeline

## CRITICAL: Sanitization Before Commit

BrainCore is published as an open-source repo. Before every `git push`, run:

```bash
bash scripts/pre-push-gate.sh
```

The gate checks for any of the following leaking into tracked files:

- **Credentials** — hardcoded passwords, environment-injected secret-holding variable names, and literal secret tokens
- **Private IPs** — RFC1918 ranges (`192.` private, `10.` private, and `172.16`–`172.31` private ranges)
- **Chat / operator IDs** — personal messaging IDs baked into code
- **Personal project names** — downstream projects that depend on BrainCore but are not part of the public distribution
- **Home paths** — any `/home/<user>` or deploy-specific install paths
- **Specific hostnames** — the names of the private machines BrainCore was first deployed on
- **The word "home-lab"** (written without the hyphen) — BrainCore is general AI-infra memory, not scoped to one environment
- **Inline database connection strings** — any `postgres` URL written into code or docs instead of referenced via the `BRAINCORE_POSTGRES_DSN` environment variable

Any hit blocks the push. `.env.example` is excluded — that file is the documented template and is allowed to contain example placeholder values. Fix any violation at the source rather than adding exceptions to the gate.

## Common Tasks

### Adding a new source type
1. Add enum value to `sql/001_preserve_schema.sql` (`preserve.source_type`)
2. Apply `ALTER TYPE` on the database
3. Create parser at `src/extract/<source>-parser.ts`
4. Wire CLI command in `src/cli.ts`
5. Add step to `cron/nightly.sh`
6. Test with `DRY_RUN=1 bash cron/nightly.sh`

### Adding a new MCP tool
1. Add SQL query logic to `mcp/memory_search.py` or create a new function
2. Add Pydantic model to `mcp/memory_models.py`
3. Add tool registration to the MCP server that fronts BrainCore
4. Add FastAPI endpoint

### Schema migration
1. Create `sql/006_<name>.sql` with idempotent patterns (`IF NOT EXISTS`, `DO` blocks)
2. Apply via `psql` from a host that can reach the database
3. Write backfill script in `scripts/backfill-<name>.py`
4. Update `src/extract/load.ts` to populate new column on insert
5. Update `mcp/memory_search.py` if retrieval needs to change

## Environment Variables

All configuration via env vars. See `.env.example` for full list. Key ones:

| Var | Required | Purpose |
|-----|----------|---------|
| `BRAINCORE_POSTGRES_DSN` | YES | PostgreSQL connection |
| `BRAINCORE_VAULT_ROOT` | YES | Path to your vault/data source |
| `BRAINCORE_VLLM_ENDPOINTS` | optional | `name=url,name=url` format |
| `BRAINCORE_EMBED_URL` | optional | Embedding service URL |
| `BRAINCORE_CLAUDE_MODEL` | optional | Fallback LLM model |
| `BRAINCORE_TELEGRAM_BOT_TOKEN` | optional | Alert notifications |
| `BRAINCORE_TENANT` | optional | Tenant scope (default: `"default"`) |
| `BRAINCORE_KNOWN_DEVICES` | optional | Comma-separated device list for entity patterns |

## Testing

```bash
# Dry-run nightly pipeline
DRY_RUN=1 bash cron/nightly.sh

# Run smoke test
bash scripts/smoke-test.sh

# Incremental pieces of the pipeline
bun src/cli.ts extract --pending --skip-semantic
bun src/cli.ts consolidate --delta

# System health
bun src/cli.ts maintenance --stats
bun src/cli.ts health-check
```

## Known Gotchas

- `extract --telegram`, `extract --grafana`, `consolidate --detect-stale` may not be in all builds — cron isolates failures gracefully
- Bar chart panels in Grafana need numeric field cast (`::int`) — use `bargauge` if `barchart` does not render
- The `mcp/memory_search.py` in this repo is a reference copy — in production deployments it typically lives alongside the MCP FastAPI server that fronts BrainCore
- Cron overlap is prevented by `flock` — if nightly is still running when next cron fires, the second run exits cleanly
