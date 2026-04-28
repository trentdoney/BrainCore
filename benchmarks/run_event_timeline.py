#!/usr/bin/env python3
"""Event-frame timeline smoke runner for BrainCore.

This benchmark layers ``seed_event_timeline_smoke.sql`` on top of the existing
synthetic smoke fixture and validates the ``memory_timeline`` read path with
non-empty event-frame data. It is a regression fixture, not a production quality
metric.
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
from psycopg_pool import ConnectionPool

from run_retrieval import (  # noqa: E402
    _public_dsn_host_label,
    fetch_corpus_stats,
    maybe_seed,
)

RESULT_DATE = "2026-04-26"
VERSION = "1.1.5"
REPO_ROOT = Path(__file__).resolve().parent.parent
BENCHMARKS_DIR = REPO_ROOT / "benchmarks"
EVENT_SEED_PATH = BENCHMARKS_DIR / "seed_event_timeline_smoke.sql"
RESULTS_DIR = BENCHMARKS_DIR / "results"
OUTPUT_PATH = RESULTS_DIR / f"{RESULT_DATE}-event-timeline.json"
TOP_K = 10

_LIB_DIR = (REPO_ROOT / "mcp").resolve()
_SYNTH_PKG = "braincore_timeline_lib"

TIMELINE_CASES = [
    {
        "id": "t01",
        "scope": "device:server-a",
        "expected_ids": [
            "ef000000-0001-0001-0001-000000000001",
            "ef000000-0001-0001-0001-000000000002",
            "ef000000-0003-0003-0003-000000000001",
            "ef000000-0003-0003-0003-000000000002",
        ],
    },
    {
        "id": "t02",
        "scope": "device:server-b",
        "event_type": "remediation",
        "expected_ids": [
            "ef000000-0002-0002-0002-000000000002",
        ],
    },
    {
        "id": "t03",
        "subject": "nginx",
        "from_ts": "2026-02-15T00:00:00Z",
        "to_ts": "2026-02-16T00:00:00Z",
        "expected_ids": [
            "ef000000-0003-0003-0003-000000000001",
            "ef000000-0003-0003-0003-000000000002",
        ],
    },
]

BEFORE_AFTER_CASES = [
    {
        "id": "ba01",
        "timestamp": "2026-02-15T10:00:00Z",
        "subject": "nginx",
        "scope": "device:server-a",
        "expected_before_ids": [
            "ef000000-0003-0003-0003-000000000001",
        ],
        "expected_after_ids": [
            "ef000000-0003-0003-0003-000000000002",
        ],
    },
    {
        "id": "ba02",
        "timestamp": "2026-02-01T13:00:00Z",
        "scope": "device:server-b",
        "expected_before_ids": [
            "ef000000-0002-0002-0002-000000000001",
        ],
        "expected_after_ids": [
            "ef000000-0002-0002-0002-000000000002",
        ],
    },
]

CAUSAL_CHAIN_CASES = [
    {
        "id": "cc01",
        "subject": "nginx",
        "scope": "device:server-a",
        "expected_episode_ids": [
            "eeeeeeee-0003-0003-0003-000000000003",
        ],
        "expected_step_ids": [
            "ef000000-0003-0003-0003-000000000001",
            "ef000000-0003-0003-0003-000000000002",
        ],
    },
    {
        "id": "cc02",
        "scope": "device:server-b",
        "expected_episode_ids": [
            "eeeeeeee-0002-0002-0002-000000000002",
        ],
        "expected_step_ids": [
            "ef000000-0002-0002-0002-000000000001",
            "ef000000-0002-0002-0002-000000000002",
        ],
    },
]


def _load_module(module_name: str, file_path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(
        f"{_SYNTH_PKG}.{module_name}",
        file_path,
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load {file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"{_SYNTH_PKG}.{module_name}"] = module
    spec.loader.exec_module(module)
    return module


def _bootstrap_timeline() -> tuple[Any, Any, Any]:
    if _SYNTH_PKG not in sys.modules:
        pkg = types.ModuleType(_SYNTH_PKG)
        pkg.__path__ = [str(_LIB_DIR)]  # type: ignore[attr-defined]
        sys.modules[_SYNTH_PKG] = pkg

    _load_module("memory_models", _LIB_DIR / "memory_models.py")

    embedder_path = _LIB_DIR / "embedder.py"
    if embedder_path.is_file():
        try:
            _load_module("embedder", embedder_path)
        except Exception:  # noqa: BLE001
            stub = types.ModuleType(f"{_SYNTH_PKG}.embedder")

            def embed_query(text: str):  # noqa: ARG001
                return np.zeros(384, dtype=np.float32)

            stub.embed_query = embed_query  # type: ignore[attr-defined]
            sys.modules[f"{_SYNTH_PKG}.embedder"] = stub
    else:
        stub = types.ModuleType(f"{_SYNTH_PKG}.embedder")

        def embed_query(text: str):  # noqa: ARG001
            return np.zeros(384, dtype=np.float32)

        stub.embed_query = embed_query  # type: ignore[attr-defined]
        sys.modules[f"{_SYNTH_PKG}.embedder"] = stub

    ms_mod = _load_module("memory_search", _LIB_DIR / "memory_search.py")
    return ms_mod.memory_timeline, ms_mod.memory_before_after, ms_mod.memory_causal_chain


def apply_event_seed(dsn: str) -> None:
    if not EVENT_SEED_PATH.is_file():
        raise RuntimeError(f"Event timeline seed not found at {EVENT_SEED_PATH}")
    seed_sql = EVENT_SEED_PATH.read_text(encoding="utf-8")
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(seed_sql)
        conn.commit()
    print(f"[seed] applied {EVENT_SEED_PATH.name} ({len(seed_sql)} bytes)")


def fetch_timeline_stats(dsn: str) -> dict[str, int]:
    stats = fetch_corpus_stats(dsn)
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM preserve.episode")
        stats["episodes"] = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM preserve.event_frame")
        stats["event_frames"] = int(cur.fetchone()[0])
    return stats


def _ids(entries: list[dict[str, Any]]) -> list[str]:
    return [entry.get("event_frame_id") for entry in entries]


def _ordered_subset(actual: list[str], expected: list[str]) -> bool:
    cursor = 0
    for item in actual:
        if cursor < len(expected) and item == expected[cursor]:
            cursor += 1
    return cursor == len(expected)


def run(no_seed: bool = False, force_seed: bool = False) -> dict[str, Any]:
    dsn = os.environ.get("BRAINCORE_TEST_DSN")
    if not dsn:
        print(
            "ERROR: BRAINCORE_TEST_DSN is not set. Export a libpq DSN "
            "pointing at a BrainCore preserve-schema database.",
            file=sys.stderr,
        )
        sys.exit(2)

    memory_timeline, memory_before_after, memory_causal_chain = _bootstrap_timeline()
    maybe_seed(dsn, no_seed=no_seed, force_seed=force_seed)
    apply_event_seed(dsn)
    corpus = fetch_timeline_stats(dsn)

    pool = ConnectionPool(conninfo=dsn, min_size=1, max_size=4, open=True)
    latencies_ms: list[float] = []
    case_reports: list[dict[str, Any]] = []
    hit_count = 0
    ordered_count = 0
    evidence_count = 0
    scope_leak_count = 0
    before_after_hit_count = 0
    before_after_evidence_count = 0
    causal_chain_hit_count = 0
    causal_chain_evidence_count = 0

    try:
        for case in TIMELINE_CASES:
            kwargs = {
                "subject": case.get("subject"),
                "scope": case.get("scope"),
                "event_type": case.get("event_type"),
                "from_ts": case.get("from_ts"),
                "to_ts": case.get("to_ts"),
                "limit": TOP_K,
            }
            t0 = time.perf_counter()
            raw = memory_timeline(pool, **kwargs)
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            latencies_ms.append(elapsed_ms)

            entries = raw.get("entries", []) or []
            actual_ids = _ids(entries)
            expected_ids = case["expected_ids"]
            hit = set(expected_ids).issubset(set(actual_ids))
            ordered = _ordered_subset(actual_ids, expected_ids)
            evidence_ok = all(entry.get("evidence") for entry in entries)
            scope = case.get("scope")
            scope_leaks = 0
            if scope:
                scope_leaks = sum(
                    1 for entry in entries
                    if not str(entry.get("scope_path") or "").startswith(scope)
                )

            hit_count += int(hit)
            ordered_count += int(ordered)
            evidence_count += int(evidence_ok)
            scope_leak_count += scope_leaks

            case_reports.append({
                "id": case["id"],
                "filters": kwargs,
                "expected_ids": expected_ids,
                "actual_ids": actual_ids,
                "hit": hit,
                "ordered": ordered,
                "evidence_present": evidence_ok,
                "scope_leaks": scope_leaks,
                "latency_ms": round(elapsed_ms, 3),
            })

        for case in BEFORE_AFTER_CASES:
            kwargs = {
                "timestamp": case["timestamp"],
                "subject": case.get("subject"),
                "scope": case.get("scope"),
                "event_type": case.get("event_type"),
                "limit_each": TOP_K,
            }
            t0 = time.perf_counter()
            raw = memory_before_after(pool, **kwargs)
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            latencies_ms.append(elapsed_ms)

            before_ids = _ids(raw.get("before", []) or [])
            after_ids = _ids(raw.get("after", []) or [])
            expected_before = case["expected_before_ids"]
            expected_after = case["expected_after_ids"]
            hit = (
                set(expected_before).issubset(set(before_ids))
                and set(expected_after).issubset(set(after_ids))
            )
            evidence_ok = all(
                entry.get("evidence")
                for entry in (raw.get("before", []) or []) + (raw.get("after", []) or [])
            )
            before_after_hit_count += int(hit)
            before_after_evidence_count += int(evidence_ok)
            case_reports.append({
                "id": case["id"],
                "kind": "before_after",
                "filters": kwargs,
                "expected_before_ids": expected_before,
                "expected_after_ids": expected_after,
                "actual_before_ids": before_ids,
                "actual_after_ids": after_ids,
                "hit": hit,
                "evidence_present": evidence_ok,
                "latency_ms": round(elapsed_ms, 3),
            })

        for case in CAUSAL_CHAIN_CASES:
            kwargs = {
                "subject": case.get("subject"),
                "scope": case.get("scope"),
                "from_ts": case.get("from_ts"),
                "to_ts": case.get("to_ts"),
                "limit": TOP_K,
            }
            t0 = time.perf_counter()
            raw = memory_causal_chain(pool, **kwargs)
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            latencies_ms.append(elapsed_ms)

            chains = raw.get("chains", []) or []
            actual_episode_ids = [chain.get("episode_id") for chain in chains]
            actual_step_ids = [
                step.get("event_frame_id")
                for chain in chains
                for step in (chain.get("steps", []) or [])
            ]
            expected_episodes = case["expected_episode_ids"]
            expected_steps = case["expected_step_ids"]
            hit = (
                set(expected_episodes).issubset(set(actual_episode_ids))
                and _ordered_subset(actual_step_ids, expected_steps)
            )
            evidence_ok = all(
                step.get("evidence")
                for chain in chains
                for step in (chain.get("steps", []) or [])
            )
            causal_chain_hit_count += int(hit)
            causal_chain_evidence_count += int(evidence_ok)
            case_reports.append({
                "id": case["id"],
                "kind": "causal_chain",
                "filters": kwargs,
                "expected_episode_ids": expected_episodes,
                "actual_episode_ids": actual_episode_ids,
                "expected_step_ids": expected_steps,
                "actual_step_ids": actual_step_ids,
                "hit": hit,
                "evidence_present": evidence_ok,
                "latency_ms": round(elapsed_ms, 3),
            })
    finally:
        pool.close()

    latencies_sorted = sorted(latencies_ms)
    p50 = round(statistics.median(latencies_sorted), 3) if latencies_sorted else 0.0
    p95 = round(latencies_sorted[-1], 3) if latencies_sorted else 0.0

    report = {
        "date": RESULT_DATE,
        "version": VERSION,
        "framing": "event-timeline-smoke-regression",
        "fixture": "benchmarks/seed_smoke.sql + benchmarks/seed_event_timeline_smoke.sql",
        "framing_note": (
            "Synthetic event-frame timeline smoke. Use this only to verify "
            "timeline filtering, ordering, evidence links, and scope isolation. "
            "Do not cite these metrics as production timeline quality."
        ),
        "corpus": corpus,
        "quality": {
            "timeline_cases": len(TIMELINE_CASES),
            "timeline_hit_count": hit_count,
            "ordered_count": ordered_count,
            "evidence_count": evidence_count,
            "scope_leak_count": scope_leak_count,
            "before_after_cases": len(BEFORE_AFTER_CASES),
            "before_after_hit_count": before_after_hit_count,
            "before_after_evidence_count": before_after_evidence_count,
            "causal_chain_cases": len(CAUSAL_CHAIN_CASES),
            "causal_chain_hit_count": causal_chain_hit_count,
            "causal_chain_evidence_count": causal_chain_evidence_count,
        },
        "latency_ms": {
            "p50": p50,
            "p95": p95,
        },
        "config": {
            "top_k": TOP_K,
        },
        "cases": case_reports,
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "python": sys.version.split()[0],
            "dsn_host": _public_dsn_host_label(dsn),
        },
    }

    if hit_count != len(TIMELINE_CASES):
        raise AssertionError(f"Expected all timeline cases to hit, got {hit_count}/{len(TIMELINE_CASES)}")
    if ordered_count != len(TIMELINE_CASES):
        raise AssertionError(f"Expected all timeline cases to preserve order, got {ordered_count}/{len(TIMELINE_CASES)}")
    if evidence_count != len(TIMELINE_CASES):
        raise AssertionError(
            f"Expected all timeline cases to include evidence for returned entries, "
            f"got {evidence_count}/{len(TIMELINE_CASES)}"
        )
    if scope_leak_count:
        raise AssertionError(f"Timeline scope leak count must be 0, got {scope_leak_count}")
    if before_after_hit_count != len(BEFORE_AFTER_CASES):
        raise AssertionError(
            f"Expected all before-after cases to hit, got {before_after_hit_count}/{len(BEFORE_AFTER_CASES)}"
        )
    if before_after_evidence_count != len(BEFORE_AFTER_CASES):
        raise AssertionError(
            f"Expected all before-after cases to include evidence, "
            f"got {before_after_evidence_count}/{len(BEFORE_AFTER_CASES)}"
        )
    if causal_chain_hit_count != len(CAUSAL_CHAIN_CASES):
        raise AssertionError(
            f"Expected all causal-chain cases to hit, "
            f"got {causal_chain_hit_count}/{len(CAUSAL_CHAIN_CASES)}"
        )
    if causal_chain_evidence_count != len(CAUSAL_CHAIN_CASES):
        raise AssertionError(
            f"Expected all causal-chain cases to include evidence, "
            f"got {causal_chain_evidence_count}/{len(CAUSAL_CHAIN_CASES)}"
        )

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, sort_keys=False)
        fh.write("\n")

    print(f"Wrote {OUTPUT_PATH}")
    print(json.dumps(report, indent=2))
    return report


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run BrainCore event timeline smoke benchmark.")
    seed_group = parser.add_mutually_exclusive_group()
    seed_group.add_argument("--no-seed", action="store_true")
    seed_group.add_argument("--force-seed", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    run(no_seed=args.no_seed, force_seed=args.force_seed)
