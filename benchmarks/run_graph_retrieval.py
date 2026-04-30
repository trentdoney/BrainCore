#!/usr/bin/env python3
"""Graph retrieval smoke runner for BrainCore.

This benchmark is intentionally separate from ``run_retrieval.py``. It layers
``seed_graph_smoke.sql`` on top of the existing synthetic smoke fixture and
checks that graph retrieval contributes candidates and path explanations when
``include_graph=True`` while remaining absent from graph-disabled searches.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg
from psycopg_pool import ConnectionPool

from run_retrieval import (  # noqa: E402
    RRF_K,
    TOP_K,
    _bootstrap_library,
    _public_dsn_host_label,
    fetch_corpus_stats,
    maybe_seed,
)

RESULT_DATE = "2026-04-26"
VERSION = "1.1.6"
REPO_ROOT = Path(__file__).resolve().parent.parent
BENCHMARKS_DIR = REPO_ROOT / "benchmarks"
GRAPH_SEED_PATH = BENCHMARKS_DIR / "seed_graph_smoke.sql"
RESULTS_DIR = BENCHMARKS_DIR / "results"
OUTPUT_PATH = RESULTS_DIR / f"{RESULT_DATE}-graph-retrieval.json"

GRAPH_CASES = [
    {
        "id": "g01",
        "query": "log rotation remediation for docker container logs",
        "expected_object_id": "a0000000-0000-0000-0000-00000000001d",
        "expected_title": "Docker log rotation and disk management playbook",
    },
    {
        "id": "g02",
        "query": "max_standby_streaming_delay fix WAL replay",
        "expected_object_id": "a0000000-0000-0000-0000-00000000003d",
        "expected_title": "PostgreSQL replication lag and WAL replay playbook",
    },
    {
        "id": "g03",
        "query": "certbot auto-renewal after nginx outage",
        "expected_object_id": "a0000000-0000-0000-0000-00000000016d",
        "expected_title": "TLS timer operational playbook",
    },
]


def apply_graph_seed(dsn: str) -> None:
    if not GRAPH_SEED_PATH.is_file():
        raise RuntimeError(f"Graph seed not found at {GRAPH_SEED_PATH}")
    seed_sql = GRAPH_SEED_PATH.read_text(encoding="utf-8")
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(seed_sql)
        conn.commit()
    print(f"[seed] applied {GRAPH_SEED_PATH.name} ({len(seed_sql)} bytes)")


def _has_expected_result(results: list[dict[str, Any]], object_id: str) -> bool:
    return any(r.get("object_id") == object_id for r in results[:TOP_K])


def _has_path_for_expected(results: list[dict[str, Any]], object_id: str) -> bool:
    for result in results[:TOP_K]:
        if result.get("object_id") != object_id:
            continue
        return any(step.get("object_type") == "memory_edge" for step in result.get("why", []))
    return False


def run(no_seed: bool = False, force_seed: bool = False) -> dict[str, Any]:
    dsn = os.environ.get("BRAINCORE_TEST_DSN")
    if not dsn:
        print(
            "ERROR: BRAINCORE_TEST_DSN is not set. Export a libpq DSN "
            "pointing at a BrainCore preserve-schema database.",
            file=sys.stderr,
        )
        sys.exit(2)

    memory_search, _embed_query, vector_disabled = _bootstrap_library()
    maybe_seed(dsn, no_seed=no_seed, force_seed=force_seed)
    apply_graph_seed(dsn)
    corpus = fetch_corpus_stats(dsn)

    pool = ConnectionPool(conninfo=dsn, min_size=1, max_size=4, open=True)
    case_reports: list[dict[str, Any]] = []
    latencies_ms: list[float] = []
    graph_candidate_count = 0
    graph_hit_count = 0
    path_explanation_count = 0
    disabled_graph_stream_violations = 0

    try:
        for case in GRAPH_CASES:
            disabled = memory_search(
                pool,
                query=case["query"],
                limit=TOP_K,
                include_graph=False,
                explain_paths=True,
            )
            t0 = time.perf_counter()
            enabled = memory_search(
                pool,
                query=case["query"],
                limit=TOP_K,
                include_graph=True,
                explain_paths=True,
            )
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            latencies_ms.append(elapsed_ms)

            disabled_counts = disabled.get("stream_counts", {}) or {}
            enabled_counts = enabled.get("stream_counts", {}) or {}
            if "graph" in disabled_counts:
                disabled_graph_stream_violations += 1

            graph_count = int(enabled_counts.get("graph", 0) or 0)
            graph_candidate_count += graph_count
            enabled_results = enabled.get("results", []) or []
            hit = _has_expected_result(enabled_results, case["expected_object_id"])
            path = _has_path_for_expected(enabled_results, case["expected_object_id"])
            graph_hit_count += int(hit)
            path_explanation_count += int(path)

            case_reports.append({
                "id": case["id"],
                "query": case["query"],
                "expected_title": case["expected_title"],
                "graph_candidates": graph_count,
                "hit": hit,
                "path_explanation": path,
                "latency_ms": round(elapsed_ms, 3),
                "disabled_stream_counts": disabled_counts,
                "enabled_stream_counts": enabled_counts,
            })
    finally:
        pool.close()

    latencies_sorted = sorted(latencies_ms)
    p50 = round(statistics.median(latencies_sorted), 3) if latencies_sorted else 0.0
    p95 = round(latencies_sorted[-1], 3) if latencies_sorted else 0.0

    report = {
        "date": RESULT_DATE,
        "version": VERSION,
        "framing": "graph-smoke-regression",
        "fixture": "benchmarks/seed_smoke.sql + benchmarks/seed_graph_smoke.sql",
        "framing_note": (
            "Synthetic graph retrieval smoke. Use this only to verify graph "
            "stream wiring, path explanations, and graph-disabled behavior. "
            "Do not cite these metrics as production retrieval quality."
        ),
        "corpus": corpus,
        "quality": {
            "graph_cases": len(GRAPH_CASES),
            "graph_candidate_count": graph_candidate_count,
            "graph_hit_count": graph_hit_count,
            "path_explanation_count": path_explanation_count,
            "disabled_graph_stream_violations": disabled_graph_stream_violations,
        },
        "latency_ms": {
            "p50": p50,
            "p95": p95,
        },
        "config": {
            "rrf_k": RRF_K,
            "top_k": TOP_K,
            "vector_disabled": vector_disabled,
        },
        "cases": case_reports,
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "python": sys.version.split()[0],
            "dsn_host": _public_dsn_host_label(dsn),
        },
    }

    if graph_hit_count != len(GRAPH_CASES):
        raise AssertionError(f"Expected all graph cases to hit, got {graph_hit_count}/{len(GRAPH_CASES)}")
    if path_explanation_count != len(GRAPH_CASES):
        raise AssertionError(
            f"Expected all graph cases to include memory_edge path explanations, "
            f"got {path_explanation_count}/{len(GRAPH_CASES)}"
        )
    if disabled_graph_stream_violations:
        raise AssertionError("Graph-disabled searches unexpectedly reported graph stream counts")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, sort_keys=False)
        fh.write("\n")

    print(f"Wrote {OUTPUT_PATH}")
    print(json.dumps(report, indent=2))
    return report


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run BrainCore graph retrieval smoke benchmark.")
    seed_group = parser.add_mutually_exclusive_group()
    seed_group.add_argument("--no-seed", action="store_true")
    seed_group.add_argument("--force-seed", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    run(no_seed=args.no_seed, force_seed=args.force_seed)
