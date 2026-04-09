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
│   ├── archive/         # Scanner, archiver, replicator
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
│   ├── llm/             # Client with auto-fallback
│   ├── project/         # Archive/merge/fork operations
│   ├── publish/         # Markdown note publisher
│   ├── security/        # Secret scanner
│   └── eval/            # Evaluation harness
├── mcp/                 # Python — MCP layer (read-only)
│   ├── memory_models.py # Pydantic models
│   └── memory_search.py # 4-stream hybrid retrieval with priority boost + tenant filter
├── sql/                 # Schema migrations
│   ├── 001_preserve_schema.sql
│   ├── 003_seed_entities.sql
│   ├── 004_seed_projects.example.sql
│   └── 005_priority_tenant.sql
├── scripts/             # Python backfill scripts
│   ├── backfill-embeddings.py
│   ├── backfill-priority.py
│   ├── backfill-tenant.py
│   ├── backfill-temporal.py
│   ├── retag-projects.py
│   └── retag-milestones.py
├── cron/
│   └── nightly.sh       # Parallel pipeline with flock + DRY_RUN + failure isolation
├── examples/
│   ├── docker-compose.yml   # PostgreSQL + pgvector
│   ├── seed-projects.sql
│   └── sample-vault/        # 3 fictional incidents for smoke testing
├── .env                 # SECRETS — gitignored, 0600 perms, NEVER commit
├── .env.example         # Documented template
├── README.md            # User-facing docs
├── AGENTS.md            # THIS FILE
├── CLAUDE.md            # Claude Code instructions
├── SECURITY.md          # Security posture
└── SETUP.md             # Installation guide
```

## Language Boundary

- **TypeScript (Bun) owns WRITES**: scan, archive, extract, consolidate, publish, project lifecycle
- **Python owns READS**: MCP tools, retrieval queries (memory_search.py), embeddings
- **All shared state through PostgreSQL** — no direct inter-process calls
- **Embeddings via HTTP**: TypeScript calls the FastAPI /embed endpoint, does not load models in Bun

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

BrainCore is a **public repo**. Before every git push, run these 8 gates. Any match = blocker:

```bash
cd /srv/tools/BrainCore && \
echo "Gate 1 credentials:" && git ls-files | xargs grep -l '4c31f52e\|PGPASSWORD' 2>/dev/null; \
echo "Gate 2 private IPs:" && git ls-files | xargs grep -l '192\.168\.\|10\.0\.\|172\.1[6-9]\.' 2>/dev/null | grep -v .env.example; \
echo "Gate 3 chat IDs:" && git ls-files | xargs grep -l '8711262954\|1341790623' 2>/dev/null; \
echo "Gate 4 personal projects:" && git ls-files | xargs grep -l 'shockfeed\|onlyfans\|brandibaby\|polymarket\|nanoclaw\|DAD_Case\|buddyx' 2>/dev/null; \
echo "Gate 5 home paths:" && git ls-files | xargs grep -l '/home/minion\|/srv/tools/BrainCore\|/opt/opsvault' 2>/dev/null | grep -v .env.example; \
echo "Gate 6 hostnames:" && git ls-files | xargs grep -l '\blila\b\|\bminion\b\|\brava\b\|\bblade\b' 2>/dev/null | grep -v .env.example | grep -v README.md; \
echo "Gate 7 homelab literal:" && git ls-files | xargs grep -l 'homelab' 2>/dev/null | grep -v .env.example; \
echo "Gate 8 dsn keys:" && git ls-files | xargs grep -l 'postgresql://[^$]' 2>/dev/null | grep -v .env.example
```

Expected output: all gates empty.

## Common Tasks

### Adding a new source type
1. Add enum value to `sql/001_preserve_schema.sql` (`preserve.source_type`)
2. Apply ALTER TYPE on the database
3. Create parser at `src/extract/<source>-parser.ts`
4. Wire CLI command in `src/cli.ts`
5. Update scanner at `src/archive/scanner.ts`
6. Add step to `cron/nightly.sh`
7. Test with `DRY_RUN=1 bash cron/nightly.sh`

### Adding a new MCP tool
1. Add SQL query logic to `mcp/memory_search.py` or create a new function
2. Add Pydantic model to `mcp/memory_models.py`
3. Add tool registration to the OpsVault MCP server (separate repo/location)
4. Add FastAPI endpoint

### Schema migration
1. Create `sql/006_<name>.sql` with idempotent patterns (IF NOT EXISTS, DO blocks)
2. Apply via psql from lila (the only machine with psql)
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
| `BRAINCORE_TENANT` | optional | Tenant scope (default: "default") |
| `BRAINCORE_KNOWN_DEVICES` | optional | Comma-separated device list for entity patterns |

## Testing

```bash
# Dry-run nightly pipeline
DRY_RUN=1 bash cron/nightly.sh

# Run smoke test
bun src/cli.ts scan
bun src/cli.ts extract --pending --skip-semantic
bun src/cli.ts consolidate --delta

# System health
bun src/cli.ts maintenance --stats
bun src/cli.ts health-check
```

## Known Gotchas

- `extract --telegram`, `extract --grafana`, `consolidate --detect-stale` may not be in all builds — cron isolates failures gracefully
- Bar chart panels in Grafana need numeric field cast (`::int`) — use bargauge if barchart doesnt render
- The `mcp/memory_search.py` in this repo is a reference copy — in production it lives alongside the MCP FastAPI server
- Cron overlap is prevented by flock — if nightly is still running when next cron fires, the second run exits cleanly
