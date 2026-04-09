# BrainCore

Autonomous memory system for AI infrastructure. BrainCore extracts, preserves, and retrieves operational knowledge from incidents, coding sessions, chat messages, and monitoring data — building a persistent knowledge graph that AI agents can query.

## What It Does

BrainCore watches your infrastructure and automatically:
1. **Scans** for new incidents, sessions, and artifacts
2. **Archives** them with integrity checksums
3. **Extracts** structured facts using deterministic parsing + LLM semantic analysis
4. **Consolidates** recurring patterns into actionable memories and playbooks
5. **Publishes** knowledge as searchable, queryable data

All knowledge is stored in PostgreSQL with pgvector, enabling 4-stream hybrid retrieval (SQL + full-text + vector + temporal) with Reciprocal Rank Fusion.

## Features

- **7 data source parsers**: OpsVault incidents, Claude Code sessions, Codex sessions, Discord digests, Telegram chats, Grafana alerts, PAI memory
- **4-stream hybrid retrieval**: Structured SQL + FTS + vector similarity + temporal expansion, fused with RRF (k=60)
- **Trust classes**: `deterministic`, `corroborated_llm`, `single_source_llm`, `human_curated`
- **15 MCP tools**: memory search, state-at-time, timeline, explain, milestones, project lifecycle
- **Project scoping**: Facts, memories, and episodes auto-tagged to projects via service mapping
- **Quality gate**: SHA256 fingerprint dedup, secret redaction, assertion class validation
- **Local-first LLM**: Uses vLLM (OpenAI-compatible) with automatic Claude CLI fallback
- **19-step nightly pipeline**: Fully automated scan-archive-extract-consolidate-publish cycle
- **Eval framework**: Gold-set benchmark with precision, recall, and evidence grounding metrics

## Quick Start

```bash
# 1. Set up PostgreSQL with pgvector
docker compose -f examples/docker-compose.yml up -d

# 2. Install dependencies
bun install

# 3. Initialize the schema
psql "$BRAINCORE_POSTGRES_DSN" -f sql/001_preserve_schema.sql
psql "$BRAINCORE_POSTGRES_DSN" -f sql/003_seed_entities.sql

# 4. Copy and edit environment config
cp .env.example .env
# Edit .env with your database credentials and endpoints

# 5. Run a scan
bun src/cli.ts scan --lead-window 14

# 6. Extract from an incident
bun src/cli.ts extract --incident ./data/vault/incidents/INC-001
```

## CLI Commands

```
braincore scan              Discover new artifacts (incidents, sessions)
braincore archive --pending Archive discovered artifacts
braincore extract --pending Extract facts from archived artifacts
braincore extract --incident <path>     Extract single incident
braincore extract --session <path>      Extract Claude session
braincore extract --codex-history       Extract Codex CLI history
braincore extract --codex-shared        Extract Codex shared memory
braincore extract --discord             Extract Discord digest summaries
braincore extract --telegram            Extract Telegram chat messages
braincore extract --grafana             Extract Grafana alert annotations
braincore consolidate --delta           Find patterns + compile playbooks
braincore publish-notes --changed       Publish memories as markdown
braincore eval --run                    Run retrieval evaluation benchmark
braincore gate-check                    Check for blocked/failed artifacts
braincore health-check                  Check vLLM endpoint health
braincore project list                  List projects with stats
braincore project archive <name>        Archive a project
braincore project merge <src> <dst>     Merge two projects
braincore project fork <src> <new>      Fork a project
braincore replicate                     Replicate archives to backup
braincore maintenance --vacuum          Run weekly VACUUM
braincore maintenance --detect-stale    Detect stale memories
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
Incidents    ──┐     ┌─ Scanner ──────────┐         PostgreSQL + pgvector
Sessions     ──┤     │  Archive           │         ├─ preserve.artifact
Discord      ──┼────▶│  Deterministic     │────────▶├─ preserve.fact
Telegram     ──┤     │  Semantic (LLM)    │         ├─ preserve.memory
Grafana      ──┤     │  Quality Gate      │         ├─ preserve.episode
Codex        ──┘     │  Consolidate       │         ├─ preserve.entity
                     │  Publish           │         └─ preserve.segment
                     └────────────────────┘
                            │                       MCP Server
                     ┌──────┴───────┐               ├─ Hybrid retrieval
                     │ Nightly Cron │               ├─ State-at-time
                     │ (19 steps)   │               ├─ Timeline
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
