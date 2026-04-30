# BrainCore Benchmarks

Reproducible regression checks for BrainCore's hybrid retrieval and the
production-corpus measurements used by the launch README. The
scripts here exercise the retrieval and grounding paths end-to-end
against a deterministic synthetic fixture, producing JSON reports that
act as a CI-gated signal for the pipeline wiring. Every numeric claim
bound to one of these JSON reports flows through
`claims-to-evidence.yaml` and is verified by
`verify_claims_to_evidence.py` as a merge gate in CI.

## Scope

- This is a pipeline regression check, not a representative corpus benchmark.
- The 9 facts / 9 entities / 15 memories / 0.4167 relevance numbers come from a synthetic fixture tuned to the canonical query set.
- Launch README proof numbers come from separate production-corpus artifacts run against a naturally-populated deployment.

## Contents

- `run_retrieval.py` — runs the 12-query canonical set and records end-to-end latency, per-stream candidate counts, corpus stats, and a gold-truth relevance score.
- `run_grounding.py` — computes `grounding_rate` directly from `preserve.fact_evidence` coverage.
- `run_ops_memory_bench.py` — runs BrainCoreOpsMemoryBench across fact recall, timeline recall, causal chains, scope isolation, graph-path explanations, procedure reuse, multimodal metadata/vector retrieval, working-memory promotion/expiry, retention review-only decisions, and deterministic reranking behavior.
- `canonical_queries.yaml` — the 12-query probe set, derived from the three sample-vault incidents.
- `claims-to-evidence.yaml` — launch-ready binding between README claims and evidence sources.
- `verify_tool_index.py` — CI gate that diffs `.agents/TOOL_INDEX.yaml` against the tools registered on the example FastMCP app.
- `verify_claims_to_evidence.py` — CI gate that greps README.md for numeric patterns and verifies each claim against the YAML binding.
- `results/` — committed JSON output from the last benchmark run.

## Committed production-corpus artifacts

Two committed JSON files back the launch README claims:

- `results/2026-04-09-retrieval-production.json` — live-corpus facts, latency, and stream-health measurement against a naturally-populated BrainCore deployment. Its vector stream was disabled, so cite it for corpus size, latency, and stream wiring only.
- `results/2026-04-09-grounding-production.json` — live-corpus evidence coverage (`fact_evidence` support) for the same deployment.

These are distinct from the synthetic smoke artifacts:

- `results/2026-04-09-retrieval.json`
- `results/2026-04-09-grounding.json`
- `results/2026-04-26-retrieval-vector-production.json` — live-corpus vector-stream smoke with `config.vector_disabled = false`; use it only to prove the vector stream is exercised, not as a retrieval-quality claim.

Use the production artifacts for launch README claims. Use the smoke artifacts for CI regression gating.

## Prerequisites

- PostgreSQL 15+ (tested on 16) with the `pgvector` extension. The canonical CI image is `pgvector/pgvector:pg16`.
- Python 3.11+ with `psycopg[binary]`, `psycopg_pool`, `numpy`, `yaml`, and `requests` available. BrainCore does not vendor these as dependencies of the core TypeScript pipeline; install them into a separate virtualenv used only for the Python retrieval library and these benchmarks.
- `bun` 1.1+ for the TypeScript ingestion side of the smoke test.
- `BRAINCORE_TEST_DSN` env var pointing at a migrated preserve-schema database.

## Reproduction

```bash
# 1. Spin up Postgres 16 + pgvector
docker run -d --name braincore-bench-pg \
  -p 5555:5432 -e POSTGRES_PASSWORD=postgres \
  pgvector/pgvector:pg16
sleep 3
export BRAINCORE_TEST_DSN='<libpq DSN>'

# 2. Apply the locked migration order.
bun src/cli.ts migrate

# 3. Sanity-check the schema.
psql "$BRAINCORE_TEST_DSN" \
  -c "SELECT count(*) FROM pg_tables WHERE schemaname='preserve';"

# 4. Run the retrieval smoke. run_retrieval.py auto-applies
#    the synthetic fixture when preserve.fact is empty.
python benchmarks/run_retrieval.py

# 5. Run the grounding smoke.
python benchmarks/run_grounding.py

# 6. Run the broader operational memory benchmark.
python benchmarks/run_ops_memory_bench.py

# 7. Verify the claims gate after the README is updated.
python benchmarks/verify_claims_to_evidence.py --self-test
python benchmarks/verify_tool_index.py --self-test

# 7. Cleanup.
docker rm -f braincore-bench-pg
```

## Output schemas

### `results/YYYY-MM-DD-ops-memory-bench.json`

```json
{
  "date": "2026-04-26",
  "version": "1.1.6",
  "framing": "ops-memory-smoke-regression",
  "fixture": "benchmarks/seed_smoke.sql + benchmarks/seed_event_timeline_smoke.sql + benchmarks/seed_graph_smoke.sql",
  "framing_note": "<warning: synthetic regression fixture, not a production quality benchmark>",
  "corpus": {
    "facts": N,
    "entities": N,
    "published_memories": N,
    "episodes": N,
    "event_frames": N,
    "procedures": N,
    "working_memory_items": N,
    "retention_review_queue": N,
    "media_artifacts": N,
    "visual_regions": N,
    "embedding_index_rows": N
  },
  "quality": {
    "total_scored_cases": N,
    "passed_scored_cases": N,
    "fact_hits": N,
    "timeline_hits": N,
    "timeline_ordered": N,
    "causal_chain_hits": N,
    "scope_leaks": 0,
    "graph_hits": N,
    "graph_path_explanations": N,
    "disabled_graph_stream_violations": 0,
    "procedure_hits": N,
    "procedure_operational_hits": N,
    "working_memory_hits": N,
    "retention_review_hits": N,
    "multimodal_hits": N,
    "reranking_hits": N,
    "procedure_cases_scored": N,
    "procedure_operational_cases_scored": N,
    "working_memory_cases_scored": N,
    "retention_cases_scored": N,
    "multimodal_cases_scored": N,
    "reranking_cases_scored": N
  },
  "latency_ms": {"p50": N, "p95": N},
  "config": {"rrf_k": 60, "top_k": 10, "vector_disabled": bool},
  "cases": {
    "fact_recall": [],
    "timeline_recall": [],
    "causal_chain": [],
    "scope_isolation": [],
    "graph_path": [],
    "procedure_reuse": [],
    "procedure_operational": [],
    "working_memory": [],
    "retention_review": [],
    "multimodal_retrieval": [],
    "reranking_behavior": [],
    "procedure_schema": {"status": "schema_present_scored", "scored": true},
    "multimodal_schema": {"status": "schema_present_scored", "scored": true}
  },
  "metadata": {"generated_at": "<ISO8601 UTC>", "python": "<version>", "dsn_host": "<host>"}
}
```

BrainCoreOpsMemoryBench is a synthetic regression suite for implemented
operational-memory behavior. It is not a representative production quality
benchmark.

The multimodal track seeds a metadata-only document artifact, one visual
region, and role-specific `embedding_index` rows for `media_caption`,
`visual_ocr`, and `visual_caption`. It scores raw-artifact-safe visual metadata
retrieval whenever the multimodal schema exists, and scores opt-in media/visual
vector retrieval when the embedder is available.

### `results/YYYY-MM-DD-retrieval.json`

```json
{
  "date": "2026-04-09",
  "version": "1.1.6",
  "framing": "smoke-regression",
  "fixture": "synthetic fixture",
  "framing_note": "<warning: this is a pipeline-regression baseline, not a representative measurement; do NOT cite relevance_at_10 or any latency value as a performance claim>",
  "corpus": {"facts": N, "entities": N, "published_memories": N},
  "latency_ms": {"p50": N, "p95": N, "p99": N},
  "quality": {"relevance_at_10": N, "canonical_queries": 12},
  "streams": {"sql": N, "fts": N, "vector": N|null, "temporal": N},
  "config": {"rrf_k": 60, "top_k": 10, "vector_disabled": bool},
  "metadata": {"generated_at": "<ISO8601 UTC>", "python": "<version>", "dsn_host": "<host>"}
}
```

The top fields (`framing`, `fixture` or `source`, `framing_note`) are self-describing provenance markers. Files emitted by `run_retrieval.py` use `framing: "smoke-regression"` plus a synthetic-fixture `fixture` field. The committed production artifact uses `framing: "production-corpus"` and replaces `fixture` with a deployment-oriented `source` field.

### `results/YYYY-MM-DD-grounding.json`

```json
{
  "date": "2026-04-09",
  "version": "1.1.6",
  "framing": "smoke-regression",
  "fixture": "synthetic fixture",
  "framing_note": "<warning: smoke-regression signal only; do NOT cite grounding_rate as a representative claim>",
  "grounding_rate": N,
  "total_cases": N,
  "grounded_cases": N,
  "source": "direct fact_evidence count" | "bun eval subcommand",
  "notes": "<short rationale for the source choice>",
  "metadata": {"generated_at": "<ISO8601 UTC>", "python": "<version>", "dsn_host": "<host>"}
}
```

### `results/YYYY-MM-DD-grounding-production.json`

```json
{
  "date": "2026-04-09",
  "version": "1.1.6",
  "framing": "production-corpus",
  "source": "naturally-populated production BrainCore deployment, direct SQL count",
  "grounding_rate": 0.9852,
  "total_cases": 26966,
  "grounded_cases": 26567,
  "source_metric": "count(DISTINCT fe.fact_id) / count(fact)"
}
```

This production-corpus grounding artifact is intentionally separate from the smoke grounding artifact. It measures evidence coverage across the active tenant in a live deployment; it does not depend on the synthetic fixture.

## Known caveats

- Embedder fallback. If `BRAINCORE_EMBED_URL` is unset, or the embedder HTTP call fails for any reason, `mcp/embedder.py` returns a 384-dim zero vector and `run_retrieval.py` sets `streams.vector = null` + `config.vector_disabled = true` in the output JSON. The FTS, structured, and temporal streams continue to contribute, but vector-stream relevance is not measured. Production deployments must point `BRAINCORE_EMBED_URL` at a service that returns 384-dim vectors from the same model family as the embeddings in `preserve.{fact,memory,segment,episode}`.
- Synthetic smoke fixture, not sample-vault ingestion. The committed corpus counts come from a deterministic synthetic fixture that is auto-applied on a fresh DB by `run_retrieval.py`. This is a pipeline regression baseline, not a representative measurement. The committed production artifact has 26,966 facts and 9,074 entities; other installs will vary. Any retrieval-quality numbers intended for the launch README must come from the separate production-corpus run.
- Production relevance is not a headline claim. The committed `2026-04-09-retrieval-production.json` file records `relevance_at_10 = 0.0` for the canonical 12-query set because those queries are tuned to the synthetic sample incidents (`server-a`, `server-b`, `postgresql`, `nginx`, SSL) rather than the live deployment corpus. The production file is still valid for corpus size, latency, and stream-health claims; do not cite its relevance field in the launch README.
- 38 preserve tables, not earlier migration-era counts. After `001` through `020` plus the runtime migration ledger bootstrap, the open-source preserve schema has 38 tables. Any downstream claim that uses an older table count is stale. Every check in `claims-to-evidence.yaml` and `tests/test_migrations.py` asserts 38.
- `eval --run` subcommand. `bun src/cli.ts eval --run` is fully implemented and writes one row per run to `preserve.eval_run`. It does NOT currently emit a `grounding_rate` metric in its metrics JSONB payload; the aggregate metrics it computes are entity precision/recall/F1, fact-count ratio, root-cause match, fix-summary match, and assertion-class distribution. This is why `run_grounding.py` queries `preserve.fact_evidence` directly. When a future BrainCore release adds `grounding_rate` to the eval runner's aggregate output, flip `source` in the grounding JSON to `"bun eval subcommand"` and read the value from `preserve.eval_run.metrics->>'grounding_rate'`.
