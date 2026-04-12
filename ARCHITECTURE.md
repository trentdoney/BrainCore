# BrainCore Architecture

BrainCore is split across a write path and a read path that share state
through PostgreSQL.

- **TypeScript/Bun owns writes**: archive, extract, consolidate,
  publish, health checks, project lifecycle, and operational
  maintenance.
- **Python owns reads**: hybrid retrieval, typed request/response
  models, and the example MCP integration layer.
- **PostgreSQL with pgvector is the seam**: both sides agree on the
  `preserve` schema and nothing else.

This document explains the repo as it ships in the public launch,
including the hardening work that closed the last public-release gaps.

## Design Goals

BrainCore optimizes for five things:

1. Preserve raw evidence before interpretation.
2. Separate trust classes instead of flattening everything into one
   confidence score.
3. Make retrieval hybrid by default rather than vector-only.
4. Keep time first-class so agents can ask what was true at a given
   moment.
5. Prefer partial automation over brittle all-or-nothing pipelines.

## Repo Boundary

| Area | Files | Responsibility |
|---|---|---|
| CLI and write path | `src/` | archive, extract, consolidate, publish, eval, lifecycle |
| Retrieval library | `mcp/` | hybrid retrieval, request/response models |
| Migrations | `sql/` | open-source preserve schema definition |
| Nightly automation | `cron/` | repeatable archive/extract/consolidate cadence |
| Benchmarks and gates | `benchmarks/` | smoke regression, production artifacts, claim verification |
| Example MCP surface | `examples/mcp_server/` | reference stdio server for the retrieval library |

## Launch Contract

The public launch surface is intentionally smaller than the full repo
history:

- `bun src/cli.ts migrate` is the supported setup path.
- `bun src/cli.ts eval --run` is supported once the full `001` through
  `008` migration set has been applied.
- The example MCP server is the reference read-side integration, not a
  full MCP appliance.
- The public docs do not advertise a `scan` command as part of the
  supported launch surface.

## System Flow

```text
raw artifacts
    |
    v
archive -> extraction -> quality gate -> fact graph -> consolidation -> publish
                             |                 |
                             |                 +--> eval / review queue
                             |
                             +--> provenance anchors and trust classes
```

The pipeline is intentionally asymmetric:

- Archive happens before enrichment.
- Retrieval reads from stabilized tables rather than from transient
  extraction state.
- Consolidation only promotes sufficiently trusted material.
- Published markdown is a view, not the primary store.

## Write Path

### 1. Archive

Archive is the ingestion boundary. An artifact gets:

- a source type
- a source key
- a path
- a checksum
- size and value metadata
- preservation state

The point of archiving first is to make later extraction re-runnable.
BrainCore can revisit the same artifact with a better parser without
needing the operator to reconstruct the original source.

### 2. Extraction

Extraction mixes deterministic parsing and optional semantic inference.

Deterministic parsing lives in:

- `src/extract/session-parser.ts`
- `src/extract/codex-parser.ts`
- `src/extract/codex-shared-parser.ts`
- `src/extract/discord-parser.ts`
- `src/extract/telegram-parser.ts`
- `src/extract/grafana-parser.ts`
- `src/extract/pai-parser.ts`

Supporting extraction infrastructure lives in:

- `src/extract/deterministic.ts`
- `src/extract/semantic.ts`
- `src/extract/load.ts`
- `src/extract/quality-gate.ts`
- `src/extract/project-resolver.ts`
- `src/extract/verify.ts`

### 3. Quality Gate

The quality gate is where BrainCore stops weak output from impersonating
strong output.

Important controls:

- secret redaction before LLM transport
- evidence anchoring
- assertion-class assignment
- source-specific validation
- project scoping and priority assignment

### 4. Consolidation

Consolidation turns repeated or corroborated facts into memory objects.
The public repo splits that logic across:

- `src/consolidate/patterns.ts`
- `src/consolidate/playbooks.ts`
- `src/consolidate/importance.ts`
- `src/consolidate/updater.ts`

The consolidation path is deliberately more conservative than search.
Single-source LLM output can be searchable, but it should not promote
into durable playbooks without stronger support.

### 5. Publish

`src/publish/markdown.ts` emits markdown notes from published memories.
Those notes are useful outputs, but they are derived state. The database
remains the canonical store.

## Read Path

The read path is centered on `mcp/memory_search.py`.

### Stream 1: Structured SQL

Entity-name matching narrows to facts where the matched entity is the
subject. This is the fastest and most literal stream.

### Stream 2: Full-Text Search

FTS runs across facts, memories, segments, and episodes using
`plainto_tsquery`. It is good at exact language overlap and weaker when
queries contain many AND-constrained terms that do not co-occur in the
same row.

### Stream 3: Vector Search

Vector search depends on `mcp/embedder.py`. If no embedding service is
configured, the retrieval library degrades gracefully by returning a
zero vector and letting the remaining streams carry the query.

### Stream 4: Temporal Expansion

Temporal expansion is not just "more search." It enriches the candidate
set with related facts and episodes once the earlier streams have found
starting points.

### Fusion

The four streams are fused with Reciprocal Rank Fusion (`RRF_K = 60`).
Fusion is important because no single stream is trustworthy enough to be
the whole retrieval strategy:

- SQL is precise but narrow.
- FTS is literal but brittle.
- vector search is flexible but model-dependent.
- temporal expansion is contextual but secondary.

## Schema Walkthrough

The launch candidate ships a 16-table open-source preserve schema.

| Table | Role | Notes |
|---|---|---|
| `artifact` | ingest boundary | raw source tracker with preservation state |
| `segment` | evidence storage | excerpts, embeddings, section labels |
| `extraction_run` | audit trail | which extraction path ran and when |
| `schema_migration` | migration ledger | applied SQL files, checksums, and baselines |
| `entity` | graph anchor | devices, services, projects, incidents, sessions |
| `episode` | bounded narrative unit | incidents and sessions |
| `event` | sub-episode events | timeline granularity |
| `fact` | central truth table | assertion class, confidence, validity windows |
| `fact_evidence` | support edges | fact-to-segment links |
| `memory` | durable knowledge | patterns, heuristics, playbooks, summaries |
| `memory_support` | memory provenance | support edges back to facts and episodes |
| `publish_note` | publish state | promoted memory note paths and content hashes |
| `review_queue` | human moderation | approval and deferral state |
| `project_service_map` | project scoping | service-to-project lookup |
| `eval_run` | stored eval results | JSONB results + metrics |
| `eval_case` | eval gold set | case definitions that `eval --run` reads |

### Why `project_service_map` matters

This table was a launch blocker because the seed file used it before any
migration created it. The launch tree keeps the example seed and schema
in sync so a fresh clone does not fail during project scoping.

### Why `eval_run` and `eval_case` matter

The public CLI exposed evaluation commands before the schema defined the
tables they required. Launch hardening closes that gap:

- `sql/007_eval_run.sql` adds `preserve.eval_run`
- `sql/008_eval_case.sql` adds `preserve.eval_case`

Without those migrations, `bun src/cli.ts eval --run` fails on a clean
install.

## Trust and Promotion

BrainCore separates the concepts of:

- **searchability**
- **truth status**
- **promotion eligibility**

A fact can be searchable without being promotable. That is the reason
assertion classes exist at all.

| Class | Searchable | Promotable | Typical source |
|---|---|---|---|
| `deterministic` | yes | yes | parser output from explicit structure |
| `human_curated` | yes | yes | operator-reviewed material |
| `corroborated_llm` | yes | yes | multi-source semantic support |
| `single_source_llm` | yes | no by default | one-source semantic output |
| `retired` | yes, with context | no | superseded or demoted material |

## Temporal Model

Temporal validity shows up in two places:

- fact windows (`valid_from`, `valid_to`)
- episode windows (`start_at`, `end_at`)

That allows queries such as:

- what was true at a specific time
- what changed after a release
- what the state looked like before a remediation

Time is not a presentation feature layered on later; it is part of the
retrieval contract.

## Tenant Model

`sql/005_priority_tenant.sql` adds tenant columns across the core
tables. The retrieval library reads `BRAINCORE_TENANT` at import time
and filters to the active tenant plus the legacy `default` scope.

This is why production benchmarking needed an explicit tenant:
running the benchmark with the default tenant returned empty streams
against the live corpus.

## Priority Model

Priority is stored as an integer from 1 to 10. Retrieval applies a
priority multiplier to the fused score so important objects outrank
equally relevant but less important ones.

In practice:

- no priority means neutral
- lower numbers rank higher
- priority does not replace retrieval relevance; it biases it

## Example MCP Server

The example server in `examples/mcp_server/server.py` does three useful
things for architecture readers:

1. demonstrates the namespace-collision workaround between the repo-root
   `mcp/` directory and the PyPI `mcp` package
2. keeps the psycopg pool lazy so import-time checks do not require a
   live database
3. shows the public surface area honestly: one retrieval tool backed by
   the shared library

It is intentionally not a kitchen-sink server.

## Nightly Pipeline

`cron/nightly.sh` is built around grouped stages:

- optional codex-sync
- archive
- parallel extraction passes
- sequential post-processing
- weekly maintenance
- monthly reindex
- final gate check

It uses `flock` for overlap protection and avoids `set -e` so a single
step failure does not destroy the rest of the night.

This is an operational architecture choice, not just a shell-style one.
If extraction from one source fails, the system should still archive,
consolidate, and publish what it can.

## Benchmarking Model

The repo now carries two benchmark tiers:

### Smoke regression

- synthetic fixture
- deterministic output
- fast to rerun
- good for CI
- not a public-quality claim

### Production corpus

- measured against a real deployment
- good for facts, latency, and evidence coverage
- only defensible when the metric clearly matches the measurement scope
- not interchangeable with smoke relevance numbers

The key architecture lesson is that benchmark provenance
must travel with the artifact itself. That is why the JSON files carry
`framing` and `framing_note` fields instead of forcing the reader to
infer what sort of benchmark they are looking at.

## Security Model

Security in BrainCore is mostly about containment and redaction:

- keep secrets out of the repo
- keep private infrastructure identifiers out of public files
- treat archive and memory outputs as sensitive by default
- prefer local LLM and embedding endpoints where possible

The pre-push gate is part of architecture, not an afterthought. It is
the last line between a private operating environment and a public repo.

## Known Limitations

The launch docs are intentionally honest about what still requires the
right runtime conditions:

- `bun src/cli.ts migrate` is the supported setup path and still depends
  on a reachable PostgreSQL + pgvector database
- production relevance on the canonical smoke query set is not a valid
  public metric
- the example MCP server is deliberately minimal
- vector retrieval depends on a compatible embedding service
- the eval runner reports grounding indirectly through benchmark
  artifacts rather than as a standalone live metric

Those constraints are acceptable for launch because they are explicit in
the docs and do not pretend to be solved by prose alone.

## Related Docs

- [`README.md`](README.md)
- [`SETUP.md`](SETUP.md)
- [`SECURITY.md`](SECURITY.md)
- [`benchmarks/README.md`](benchmarks/README.md)
- [`docs/troubleshooting.md`](docs/troubleshooting.md)
- [`docs/upgrade-guide.md`](docs/upgrade-guide.md)
