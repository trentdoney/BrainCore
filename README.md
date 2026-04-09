# BrainCore

Autonomous memory system for AI infrastructure. BrainCore extracts, preserves, and retrieves operational knowledge from incidents, coding sessions, chat messages, and monitoring data — building a persistent knowledge graph that AI agents can query.

## What It Does

BrainCore watches your infrastructure and automatically:
1. **Archives** incidents, sessions, and artifacts with integrity checksums
2. **Extracts** structured facts using deterministic parsing + LLM semantic analysis
3. **Consolidates** recurring patterns into actionable memories and playbooks
4. **Publishes** knowledge as searchable, queryable data

All knowledge is stored in PostgreSQL with pgvector, enabling 4-stream hybrid retrieval (SQL + full-text + vector + temporal) with Reciprocal Rank Fusion.

## Features

- **7 data source parsers**: OpsVault incidents, Claude Code sessions, Codex sessions, Discord digests, Telegram chats, Grafana alerts, PAI memory
- **4-stream hybrid retrieval**: Structured SQL + FTS + vector similarity + temporal expansion, fused with RRF (k=60)
- **Trust classes**: `deterministic`, `corroborated_llm`, `single_source_llm`, `human_curated`
- **15 MCP tools**: memory search, state-at-time, timeline, explain, milestones, project lifecycle
- **Project scoping**: Facts, memories, and episodes auto-tagged to projects via service mapping
- **Quality gate**: SHA256 fingerprint dedup, secret redaction, assertion class validation
- **Local-first LLM**: Uses vLLM (OpenAI-compatible) with automatic Claude CLI fallback
- **Multi-step parallel nightly pipeline**: Automated archive-extract-consolidate-publish cycle with parallel extractors and health gating
- **Eval framework**: Gold-set benchmark with precision, recall, and evidence grounding metrics

## Quick Start

The example fixture at `examples/sample-vault/` ships with 3 resolved incidents you can ingest end-to-end on a fresh clone:

```bash
# 1. Install dependencies
bun install

# 2. Start PostgreSQL with pgvector
docker compose -f examples/docker-compose.yml up -d

# 3. Configure environment (edit DSN to match docker-compose credentials)
cp .env.example .env
# Set BRAINCORE_POSTGRES_DSN to match the docker-compose user/password/db
# Set BRAINCORE_VAULT_ROOT=./examples/sample-vault

# 4. Initialize schema + seed baseline entities
psql "$BRAINCORE_POSTGRES_DSN" -f sql/001_preserve_schema.sql
psql "$BRAINCORE_POSTGRES_DSN" -f sql/003_seed_entities.sql

# 5. Archive the sample incidents (discovers + checksums + registers artifacts)
bun src/cli.ts archive --pending

# 6. Extract facts (deterministic parser; add --use-claude for LLM semantic pass)
bun src/cli.ts extract --pending --skip-semantic

# 7. Consolidate deltas into patterns/playbooks
bun src/cli.ts consolidate --delta

# 8. Publish memories as markdown notes
bun src/cli.ts publish-notes --changed
```

After step 6 you should see 3 artifacts in `preserve.artifact` and facts extracted from each of the `INC-001`, `INC-002`, `INC-003` fixtures.

## CLI Commands

Run `bun src/cli.ts --help` (or `-h` / `help`) to print the full usage block. The authoritative command list is below and mirrors `src/cli.ts` exactly:

```
bun src/cli.ts <command> [options]

Commands:
  extract            Extract knowledge from incidents/sessions/PAI
    --incident <path>  Extract a single incident
    --session <path>   Extract a Claude session (JSONL)
    --pai-memory       Extract PAI AUTO memory files
    --codex-history    Extract Codex CLI history + sessions
    --codex-shared     Extract CODEX_SHARED memory structure
    --discord          Extract Discord digest micro_summaries
    --telegram         Extract Telegram chat messages
    --grafana          Extract Grafana dashboards/alerts
    --pending          Extract all pending artifacts
    --use-claude       Escalate to Claude CLI for semantic
    --skip-semantic    Skip LLM extraction, deterministic only
    --dry-run          Print results without database writes
  archive --pending    Archive discovered artifacts
  consolidate --delta  Compile patterns and playbooks
  publish-notes        Publish memories to markdown
    --changed          Only publish changed memories
    --scope <path>     Filter by scope path prefix
  eval                 Run extraction evaluation
    --run              Run eval on all gold set cases
    --report           Print last eval report
  gate-check           Report blocked/failed artifacts
  health-check         Check vLLM endpoint health
  project              Project lifecycle commands
    list               Show projects with artifact/fact counts
    tag --retag-all    Re-run project resolution on all artifacts
    archive <name>     Archive a project (--reason 'text')
    merge <src> --into <tgt>  Merge source project into target
    fork <parent> --into <child1> <child2>  Fork a project
    summary <name>     Detailed project summary
  maintenance          DB maintenance commands
    --vacuum           VACUUM ANALYZE core tables
    --detect-stale     Detect & demote stale memories
    --stats            Show table counts, index sizes, staleness
  migrate              Run database migrations
  help, --help, -h     Show this help message
```

## MCP Tools (15)

When deployed as an MCP server, BrainCore exposes:

| Tool | Description |
|------|-------------|
| `memory_search` | 4-stream hybrid search across all knowledge |
| `memory_state_at` | Get entity state at a specific point in time |
| `memory_timeline` | Get chronological timeline for an entity |
| `memory_explain` | Full provenance chain for any fact or memory |
| `memory_milestones` | List milestone facts for a project |
| `memory_embed` | Generate 384-dim embeddings for text |
| `memory_project_list` | List all projects with statistics |
| `memory_project_facts` | Get facts for a specific project |
| `memory_entity_search` | Search entities by type and name |
| `memory_recent_episodes` | Get recent episodes/incidents |
| `memory_pattern_search` | Search consolidated patterns |
| `memory_playbook_search` | Search remediation playbooks |
| `memory_fact_count` | Get fact counts by assertion class |
| `memory_quality_report` | Get extraction quality metrics |
| `memory_health` | Check system health status |

## Architecture

```
Data Sources          BrainCore Pipeline              Knowledge Store
─────────────        ────────────────────           ─────────────────
Incidents    ──┐     ┌─ Archive ──────────┐         PostgreSQL + pgvector
Sessions     ──┤     │  Deterministic     │         ├─ preserve.artifact
Discord      ──┼────▶│  Semantic (LLM)    │────────▶├─ preserve.fact
Telegram     ──┤     │  Quality Gate      │         ├─ preserve.memory
Grafana      ──┤     │  Consolidate       │         ├─ preserve.episode
Codex        ──┘     │  Publish           │         ├─ preserve.entity
                     │                    │         └─ preserve.segment
                     └────────────────────┘
                            │                       MCP Server
                     ┌──────┴───────┐               ├─ Hybrid retrieval
                     │ Nightly Cron │               ├─ State-at-time
                     │ (parallel)   │               ├─ Timeline
                     └──────────────┘               └─ Provenance
```

## Schema

BrainCore uses 12 tables in a `preserve` schema:

- **artifact** — Master tracker for all ingested sources
- **segment** — Evidence spans with FTS + vector embeddings
- **extraction_run** — Extraction audit trail
- **entity** — Devices, services, projects, files, config items
- **episode** — Incidents, sessions, time-bounded events
- **event** — Individual events within episodes
- **fact** — Central truth table with temporal validity
- **fact_evidence** — Links facts to source segments
- **memory** — Consolidated patterns and playbooks
- **memory_support** — Links memories to supporting facts/episodes
- **review_queue** — Human review workflow
- **project_service_map** — Maps services to projects

71+ indexes including HNSW vector indexes and GiST temporal range indexes.

## Setup

See [SETUP.md](SETUP.md) for detailed installation instructions.

## Security

See [SECURITY.md](SECURITY.md) for security considerations.

## License

MIT
