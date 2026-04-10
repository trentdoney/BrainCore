#!/usr/bin/env python3
"""Retrieval benchmark runner for BrainCore's 4-stream hybrid search.

Runs a canonical query set (``benchmarks/canonical_queries.yaml``) against
the BrainCore retrieval library (``mcp/memory_search.memory_search``) and
writes a JSON report with latency percentiles, per-stream candidate
contribution counts, corpus size, and a gold-truth relevance score.

Reproduction::

    export BRAINCORE_TEST_DSN='<libpq DSN>'
    python -m venv .venv && source .venv/bin/activate
    pip install 'psycopg[binary]>=3.1' psycopg-pool pyyaml numpy requests
    python benchmarks/run_retrieval.py

Self-seeding behaviour
----------------------
BrainCore's ``bun src/cli.ts scan`` subcommand is not implemented as of
v1.1.3, so a fresh clone has no way to ingest ``examples/sample-vault``
into the ``preserve.*`` tables. To make the runner reproducible on a
clean clone, this module auto-loads ``benchmarks/seed_smoke.sql`` when
``preserve.fact`` is empty. The default flow is:

1. Connect, count rows in ``preserve.fact``.
2. If the count is zero, log ``preserve.fact is empty — running
   benchmarks/seed_smoke.sql`` and execute the seed file in a single
   transaction.
3. If the count is non-zero, log ``preserve.fact has N rows — skipping
   seed`` and leave the database untouched.

Flags:
  --no-seed     Skip the auto-seed step even when ``preserve.fact`` is
                empty. Use this if you have your own data loaded and
                do not want the synthetic fixture touching your DB.
  --force-seed  Run the seed regardless of existing content. The seed
                uses ``ON CONFLICT DO NOTHING`` everywhere so it is
                idempotent; this flag exists for operators who want to
                explicitly re-apply it.

Benchmark behaviour
-------------------
1. Loads ``benchmarks/canonical_queries.yaml`` (12 queries).
2. Queries ``preserve.fact``, ``preserve.entity``, and
   ``preserve.memory WHERE lifecycle_state='published'`` for corpus stats.
3. For each query, calls ``memory_search(pool, query, limit=10)``,
   records end-to-end latency via ``time.perf_counter``, and checks
   whether any result in the top-k has an ``object_type`` and
   ``title_contains`` match from ``expected_top_k``. The per-query match
   is a single boolean; ``relevance_at_10 = matches / 12``.
4. Aggregates stream contribution counts (structured, fts, vector,
   temporal) across all queries by summing ``stream_counts`` from each
   call.
5. Embedder fallback: if ``BRAINCORE_EMBED_URL`` is unset, or the
   embedder module's ``embed_query`` returns an all-zeros vector on the
   probe call, the runner sets ``vector_disabled=True`` and writes
   ``streams.vector = null`` and ``config.vector_disabled = true`` in
   the output JSON. DO NOT fake numbers.
6. Writes ``benchmarks/results/2026-04-09-retrieval.json`` with the
   schema locked by plan §4.7.

The BrainCore retrieval library lives in a repo-root ``mcp/`` directory
that shadows the PyPI ``mcp`` package (FastMCP). This runner loads
BrainCore's library files via ``importlib.util.spec_from_file_location``
under a synthetic ``braincore_lib`` package name, mirroring the pattern
Stream B used in ``examples/mcp_server/server.py``. See that file for
background.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import statistics
import sys
import time
import types
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import psycopg
import yaml
from psycopg_pool import ConnectionPool

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

VERSION = "1.1.4"
RESULT_DATE = "2026-04-09"
TOP_K = 10
RRF_K = 60  # matches mcp/memory_search.py:27 RRF_K constant

REPO_ROOT = Path(__file__).resolve().parent.parent
BENCHMARKS_DIR = REPO_ROOT / "benchmarks"
CANONICAL_QUERIES_PATH = BENCHMARKS_DIR / "canonical_queries.yaml"
SEED_SMOKE_PATH = BENCHMARKS_DIR / "seed_smoke.sql"
RESULTS_DIR = BENCHMARKS_DIR / "results"
OUTPUT_PATH = RESULTS_DIR / f"{RESULT_DATE}-retrieval.json"


# ---------------------------------------------------------------------------
# Namespace collision guard (see examples/mcp_server/server.py for details)
# ---------------------------------------------------------------------------

_cwd = os.getcwd()
if os.path.isdir(os.path.join(_cwd, "mcp")):
    sys.path[:] = [p for p in sys.path if p not in ("", _cwd)]


# ---------------------------------------------------------------------------
# Synthetic package loader for BrainCore's retrieval library
# ---------------------------------------------------------------------------

_LIB_DIR = (REPO_ROOT / "mcp").resolve()
_SYNTH_PKG = "braincore_lib"


def _load_module(module_name: str, file_path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(
        f"{_SYNTH_PKG}.{module_name}",
        file_path,
    )
    if spec is None or spec.loader is None:
        raise ImportError(
            f"Could not create spec for {file_path}. "
            f"Expected BrainCore retrieval library at {_LIB_DIR}."
        )
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"{_SYNTH_PKG}.{module_name}"] = module
    spec.loader.exec_module(module)
    return module


def _bootstrap_library() -> tuple[Any, Any, bool]:
    """Install the synthetic package and load memory_search.

    Returns ``(memory_search_callable, embed_query_callable, vector_disabled)``.
    ``vector_disabled`` is True if the embedder cannot produce a real
    vector (URL unset, import fails, or probe returns all zeros).
    """
    if not _LIB_DIR.is_dir():
        raise RuntimeError(
            f"BrainCore retrieval library not found at {_LIB_DIR}. "
            f"Run this script from within a BrainCore checkout."
        )

    if _SYNTH_PKG not in sys.modules:
        pkg = types.ModuleType(_SYNTH_PKG)
        pkg.__path__ = [str(_LIB_DIR)]  # type: ignore[attr-defined]
        sys.modules[_SYNTH_PKG] = pkg

    _load_module("memory_models", _LIB_DIR / "memory_models.py")

    vector_disabled = False
    embedder_path = _LIB_DIR / "embedder.py"
    if embedder_path.is_file():
        try:
            emb_mod = _load_module("embedder", embedder_path)
            probe = emb_mod.embed_query("probe")
            if not isinstance(probe, np.ndarray) or not np.any(probe):
                vector_disabled = True
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] embedder import failed: {exc}; disabling vector stream")
            vector_disabled = True
            # Install a zero-vector stub so memory_search still imports.
            stub = types.ModuleType(f"{_SYNTH_PKG}.embedder")

            def embed_query(text: str):  # noqa: ARG001
                return np.zeros(384, dtype=np.float32)

            stub.embed_query = embed_query  # type: ignore[attr-defined]
            sys.modules[f"{_SYNTH_PKG}.embedder"] = stub
    else:
        print("[warn] embedder.py missing; installing zero-vector stub")
        vector_disabled = True
        stub = types.ModuleType(f"{_SYNTH_PKG}.embedder")

        def embed_query(text: str):  # noqa: ARG001
            return np.zeros(384, dtype=np.float32)

        stub.embed_query = embed_query  # type: ignore[attr-defined]
        sys.modules[f"{_SYNTH_PKG}.embedder"] = stub

    if not os.environ.get("BRAINCORE_EMBED_URL"):
        vector_disabled = True

    ms_mod = _load_module("memory_search", _LIB_DIR / "memory_search.py")

    emb_mod = sys.modules[f"{_SYNTH_PKG}.embedder"]
    return ms_mod.memory_search, emb_mod.embed_query, vector_disabled


# ---------------------------------------------------------------------------
# Self-seeding helper
# ---------------------------------------------------------------------------


def maybe_seed(dsn: str, *, no_seed: bool = False, force_seed: bool = False) -> None:
    """Auto-load benchmarks/seed_smoke.sql when preserve.fact is empty.

    Default behaviour: if ``SELECT count(*) FROM preserve.fact`` is 0,
    execute the seed file in a single transaction. Otherwise leave the
    database alone.

    ``--no-seed`` skips the check entirely (no seeding regardless of row
    count). ``--force-seed`` runs the seed unconditionally; the seed is
    idempotent via ``ON CONFLICT DO NOTHING``.

    Raises ``RuntimeError`` if the seed file is missing.
    """
    if no_seed:
        print("[seed] --no-seed set — skipping seed check entirely")
        return

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM preserve.fact")
        row = cur.fetchone()
        fact_count = int(row[0]) if row is not None else 0

    if force_seed:
        print(f"[seed] --force-seed set (preserve.fact has {fact_count} rows) — running seed_smoke.sql")
    elif fact_count == 0:
        print("[seed] preserve.fact is empty — running benchmarks/seed_smoke.sql")
    else:
        print(f"[seed] preserve.fact has {fact_count} rows — skipping seed")
        return

    if not SEED_SMOKE_PATH.is_file():
        raise RuntimeError(
            f"Seed file not found at {SEED_SMOKE_PATH}. "
            f"Expected benchmarks/seed_smoke.sql to ship alongside run_retrieval.py."
        )

    seed_sql = SEED_SMOKE_PATH.read_text(encoding="utf-8")
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(seed_sql)
        conn.commit()
    print(f"[seed] applied {SEED_SMOKE_PATH.name} ({len(seed_sql)} bytes)")


# ---------------------------------------------------------------------------
# Corpus stats
# ---------------------------------------------------------------------------


def fetch_corpus_stats(dsn: str) -> dict[str, int]:
    """Query preserve schema for corpus counts."""
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM preserve.fact")
        facts = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM preserve.entity")
        entities = int(cur.fetchone()[0])
        cur.execute(
            "SELECT count(*) FROM preserve.memory "
            "WHERE lifecycle_state = 'published'"
        )
        published_memories = int(cur.fetchone()[0])
    return {
        "facts": facts,
        "entities": entities,
        "published_memories": published_memories,
    }


# ---------------------------------------------------------------------------
# Canonical query evaluation
# ---------------------------------------------------------------------------


def _result_matches_expectation(result: dict[str, Any], expectation: dict[str, Any]) -> bool:
    """True if a single retrieval result matches one expected_top_k entry."""
    want_type = expectation.get("object_type")
    want_title_substr = expectation.get("title_contains", "")
    if want_type and result.get("object_type") != want_type:
        return False
    title = (result.get("title") or "").lower()
    return want_title_substr.lower() in title


def query_matches(results: list[dict[str, Any]], expected_top_k: list[dict[str, Any]]) -> bool:
    """True if ANY (result, expectation) pair matches in the top-k window."""
    for result in results[:TOP_K]:
        for expectation in expected_top_k:
            if _result_matches_expectation(result, expectation):
                return True
    return False


# ---------------------------------------------------------------------------
# Main benchmark driver
# ---------------------------------------------------------------------------


def run(no_seed: bool = False, force_seed: bool = False) -> dict[str, Any]:
    dsn = os.environ.get("BRAINCORE_TEST_DSN")
    if not dsn:
        print("ERROR: BRAINCORE_TEST_DSN is not set. Export a libpq DSN "
              "pointing at a BrainCore preserve-schema database.", file=sys.stderr)
        sys.exit(2)

    if not CANONICAL_QUERIES_PATH.is_file():
        print(f"ERROR: canonical queries not found at {CANONICAL_QUERIES_PATH}",
              file=sys.stderr)
        sys.exit(2)

    with CANONICAL_QUERIES_PATH.open("r", encoding="utf-8") as fh:
        queries = yaml.safe_load(fh)

    if not isinstance(queries, list) or not queries:
        print("ERROR: canonical_queries.yaml is empty or malformed", file=sys.stderr)
        sys.exit(2)

    memory_search, _embed_query, vector_disabled = _bootstrap_library()

    maybe_seed(dsn, no_seed=no_seed, force_seed=force_seed)

    corpus = fetch_corpus_stats(dsn)

    pool = ConnectionPool(conninfo=dsn, min_size=1, max_size=4, open=True)

    latencies_ms: list[float] = []
    stream_totals = {"structured": 0, "fts": 0, "vector": 0, "temporal": 0}
    matches = 0

    try:
        for q in queries:
            qid = q.get("id", "?")
            query_text = q["query"]
            expected = q.get("expected_top_k", [])

            t0 = time.perf_counter()
            try:
                raw = memory_search(
                    pool,
                    query=query_text,
                    as_of=None,
                    scope=None,
                    type_filter=None,
                    limit=TOP_K,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] query {qid} raised {type(exc).__name__}: {exc}")
                raw = {"results": [], "stream_counts": {}}
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            latencies_ms.append(elapsed_ms)

            results = raw.get("results", []) or []
            stream_counts = raw.get("stream_counts", {}) or {}
            for key in stream_totals:
                stream_totals[key] += int(stream_counts.get(key, 0) or 0)

            # Normalize result objects (memory_search may return dataclass-
            # like dicts; we only need object_type + title).
            normalized_results: list[dict[str, Any]] = []
            for r in results:
                if isinstance(r, dict):
                    normalized_results.append(r)
                else:
                    normalized_results.append(
                        {
                            "object_type": getattr(r, "object_type", None),
                            "title": getattr(r, "title", None),
                        }
                    )

            if query_matches(normalized_results, expected):
                matches += 1
    finally:
        pool.close()

    latencies_sorted = sorted(latencies_ms)
    n = len(latencies_sorted)
    if n == 0:
        p50 = p95 = p99 = 0.0
    else:
        p50 = statistics.median(latencies_sorted)
        # Use nearest-rank percentile (simple, deterministic, small-n-safe).
        def _pct(p: float) -> float:
            idx = min(n - 1, max(0, int(round((p / 100.0) * (n - 1)))))
            return round(float(latencies_sorted[idx]), 3)

        p50 = round(p50, 3)
        p95 = _pct(95)
        p99 = _pct(99)

    streams_json: dict[str, Any] = {
        "sql": stream_totals["structured"],
        "fts": stream_totals["fts"],
        "vector": None if vector_disabled else stream_totals["vector"],
        "temporal": stream_totals["temporal"],
    }

    relevance_at_10 = round(matches / len(queries), 4)

    report = {
        "date": RESULT_DATE,
        "version": VERSION,
        "framing": "smoke-regression",
        "fixture": "benchmarks/seed_smoke.sql",
        "framing_note": (
            "This JSON is a pipeline-regression smoke baseline produced against "
            f"the synthetic seed_smoke.sql fixture ({corpus['facts']} facts / "
            f"{corpus['entities']} entities / {corpus['published_memories']} "
            f"memories tuned to the {len(queries)} canonical queries). Use "
            "these numbers as a regression gate on the retrieval pipeline "
            "wiring, NOT as a representative measurement of BrainCore's "
            "retrieval quality on arbitrary workloads. Do not cite "
            "relevance_at_10 (or any latency value) as a performance claim — "
            "the public README's headline retrieval metrics come from a "
            "separate production-corpus benchmark."
        ),
        "corpus": corpus,
        "latency_ms": {
            "p50": p50,
            "p95": p95,
            "p99": p99,
        },
        "quality": {
            "relevance_at_10": relevance_at_10,
            "canonical_queries": len(queries),
        },
        "streams": streams_json,
        "config": {
            "rrf_k": RRF_K,
            "top_k": TOP_K,
            "vector_disabled": vector_disabled,
        },
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "python": sys.version.split()[0],
            "dsn_host": psycopg.conninfo.conninfo_to_dict(dsn).get("host", "unknown"),
        },
    }

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, sort_keys=False)
        fh.write("\n")

    print(f"Wrote {OUTPUT_PATH}")
    print(json.dumps(report, indent=2))
    return report


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run BrainCore's retrieval benchmark against a preserve-schema "
            "database. Auto-seeds benchmarks/seed_smoke.sql when "
            "preserve.fact is empty; use --no-seed to opt out or "
            "--force-seed to re-apply the seed unconditionally."
        )
    )
    seed_group = parser.add_mutually_exclusive_group()
    seed_group.add_argument(
        "--no-seed",
        action="store_true",
        help="Skip auto-seeding even if preserve.fact is empty.",
    )
    seed_group.add_argument(
        "--force-seed",
        action="store_true",
        help="Re-apply seed_smoke.sql regardless of current row counts (idempotent).",
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    run(no_seed=args.no_seed, force_seed=args.force_seed)
