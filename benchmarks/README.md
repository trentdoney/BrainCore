# BrainCore Benchmarks

Reproducible regression checks for BrainCore's 4-stream hybrid search
and the production-corpus measurements used by the launch README. The
scripts here exercise the retrieval and grounding paths end-to-end
against a deterministic synthetic fixture, producing JSON reports that
act as a CI-gated signal for the pipeline wiring. Every numeric claim
bound to one of these JSON reports flows through
`claims-to-evidence.yaml` and is verified by
`verify_claims_to_evidence.py` as a merge gate in CI.

## Scope

- This is a pipeline regression check, not a representative corpus benchmark.
- The 9 facts / 12 entities / 15 memories / 0.4167 relevance numbers come from a synthetic fixture tuned to the canonical query set.
- Launch README proof numbers come from separate production-corpus artifacts run against a naturally-populated deployment.

## Contents

- `run_retrieval.py` — runs the 12-query canonical set and records end-to-end latency, per-stream candidate counts, corpus stats, and a gold-truth relevance score.
- `run_grounding.py` — computes `grounding_rate` directly from `preserve.fact_evidence` coverage.
- `canonical_queries.yaml` — the 12-query probe set, derived from the three sample-vault incidents.
- `claims-to-evidence.yaml` — launch-ready binding between README claims and evidence sources.
- `verify_tool_index.py` — CI gate that diffs `.agents/TOOL_INDEX.yaml` against the tools registered on the example FastMCP app.
- `verify_claims_to_evidence.py` — CI gate that greps README.md for numeric patterns and verifies each claim against the YAML binding.
- `results/` — committed JSON output from the last benchmark run.

## Committed production-corpus artifacts

Two committed JSON files back the launch README claims:

- `results/2026-04-09-retrieval-production.json` — live-corpus facts, latency, and stream-health measurement against a naturally-populated BrainCore deployment.
- `results/2026-04-09-grounding-production.json` — live-corpus evidence coverage (`fact_evidence` support) for the same deployment.

These are distinct from the synthetic smoke artifacts:

- `results/2026-04-09-retrieval.json`
- `results/2026-04-09-grounding.json`

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

# 2. Apply the 8 migration files in filename-sort order.
bun src/cli.ts migrate

# 3. Sanity-check the schema: 16 preserve tables
psql "$BRAINCORE_TEST_DSN" \
  -c "SELECT count(*) FROM pg_tables WHERE schemaname='preserve';"
# Expected: 16

# 4. Run the retrieval smoke. run_retrieval.py auto-applies
#    the synthetic fixture when preserve.fact is empty.
python benchmarks/run_retrieval.py

# 5. Run the grounding smoke.
python benchmarks/run_grounding.py

# 6. Verify the claims gate after the README is updated.
python benchmarks/verify_claims_to_evidence.py --self-test
python benchmarks/verify_tool_index.py --self-test

# 7. Cleanup.
docker rm -f braincore-bench-pg
```

## Output schemas

### `results/YYYY-MM-DD-retrieval.json`

```json
{
  "date": "2026-04-09",
  "version": "1.1.4",
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
  "version": "1.1.4",
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
  "version": "1.1.4",
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
- Synthetic smoke fixture, not sample-vault ingestion. The committed corpus counts come from a deterministic synthetic fixture that is auto-applied on a fresh DB by `run_retrieval.py`. This is a pipeline regression baseline, not a representative measurement. A production BrainCore install typically has 10k+ facts and 1k+ entities; the runners can be pointed at such a corpus, but any retrieval-quality numbers intended for the launch README must come from the separate production-corpus run.
- Production relevance is not a headline claim. The committed `2026-04-09-retrieval-production.json` file records `relevance_at_10 = 0.0` for the canonical 12-query set because those queries are tuned to the synthetic sample incidents (`server-a`, `server-b`, `postgresql`, `nginx`, SSL) rather than the live deployment corpus. The production file is still valid for corpus size, latency, and stream-health claims; do not cite its relevance field in the launch README.
- 16 preserve tables, not 12, 13, or 14. After `001` through `010` plus the runtime migration ledger bootstrap, the open-source preserve schema has 16 tables. Any downstream claim that reads "12 preserve tables", "13 preserve tables", or "14 preserve tables" is stale. Every check in `claims-to-evidence.yaml` and `tests/test_migrations.py` asserts 16.
- `eval --run` subcommand. `bun src/cli.ts eval --run` is fully implemented and writes one row per run to `preserve.eval_run`. It does NOT currently emit a `grounding_rate` metric in its metrics JSONB payload; the aggregate metrics it computes are entity precision/recall/F1, fact-count ratio, root-cause match, fix-summary match, and assertion-class distribution. This is why `run_grounding.py` queries `preserve.fact_evidence` directly. When a future BrainCore release adds `grounding_rate` to the eval runner's aggregate output, flip `source` in the grounding JSON to `"bun eval subcommand"` and read the value from `preserve.eval_run.metrics->>'grounding_rate'`.
