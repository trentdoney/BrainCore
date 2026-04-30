#!/usr/bin/env python3
"""Grounding benchmark runner for BrainCore fact extraction.

Reports the ``grounding_rate`` — the fraction of facts in the preserve
schema that are backed by at least one row in ``preserve.fact_evidence``.

Reproduction::

    export BRAINCORE_TEST_DSN='<libpq DSN>'
    python -m venv .venv && source .venv/bin/activate
    pip install 'psycopg[binary]>=3.1'
    python benchmarks/run_grounding.py

Implementation choice
---------------------
An earlier benchmark design considered running
``bun src/cli.ts eval --run --subset smoke`` and reading the latest row
of ``preserve.eval_run``. Direct inspection of the shipped CLI found:

1. ``eval --run`` IS implemented (not a stub like ``migrate``). It calls
   ``runEval`` from ``src/eval/runner.ts`` against all gold-set cases
   and stores one row in ``preserve.eval_run``.
2. ``--subset smoke`` is NOT parsed. The cli.ts eval branch only checks
   ``hasFlag("run")`` and ``hasFlag("report")``. Passing ``--subset
   smoke`` is a silent no-op.
3. More importantly, ``src/eval/runner.ts`` computes entity precision /
   recall / F1, fact_count ratio, root-cause match, fix-summary match,
   and assertion-class distribution. **It does NOT compute a
   grounding_rate.** The metric the public README will cite is derived
   directly from ``preserve.fact_evidence`` coverage, which is a
   simpler, more auditable signal than the eval-runner aggregate
   metrics.

Given the mismatch between plan schema and runner output, this script
computes grounding_rate directly from SQL. The output JSON records
``source: "direct fact_evidence count"`` so downstream CI gates can
verify provenance. If a future BrainCore release teaches
``src/eval/runner.ts`` to emit grounding_rate, flip the source to
``"bun eval subcommand"`` and read the metrics JSONB from the latest
``preserve.eval_run`` row.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg

VERSION = "1.1.6"
RESULT_DATE = "2026-04-09"

REPO_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = REPO_ROOT / "benchmarks" / "results"
OUTPUT_PATH = RESULTS_DIR / f"{RESULT_DATE}-grounding.json"


def _public_dsn_host_label(dsn: str) -> str:
    """Return redacted DB-host metadata safe for committed artifacts."""
    host = psycopg.conninfo.conninfo_to_dict(dsn).get("host")
    if host in (None, "", "localhost"):
        return "localhost"
    return "redacted"


def fetch_grounding_counts(dsn: str) -> tuple[int, int]:
    """Return ``(total_facts, grounded_facts)``.

    ``grounded_facts`` is the distinct count of ``fact_id`` values that
    appear at least once in ``preserve.fact_evidence``.
    """
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM preserve.fact")
        total = int(cur.fetchone()[0])
        cur.execute(
            "SELECT count(DISTINCT fact_id) FROM preserve.fact_evidence "
            "WHERE fact_id IS NOT NULL"
        )
        grounded = int(cur.fetchone()[0])
    return total, grounded


def run() -> dict[str, Any]:
    dsn = os.environ.get("BRAINCORE_TEST_DSN")
    if not dsn:
        print("ERROR: BRAINCORE_TEST_DSN is not set. Export a libpq DSN "
              "pointing at a BrainCore preserve-schema database.",
              file=sys.stderr)
        sys.exit(2)

    total, grounded = fetch_grounding_counts(dsn)
    rate = round(grounded / total, 4) if total > 0 else 0.0

    report = {
        "date": RESULT_DATE,
        "version": VERSION,
        "framing": "smoke-regression",
        "fixture": "benchmarks/seed_smoke.sql",
        "framing_note": (
            "This JSON is a pipeline-regression smoke baseline produced "
            "against the synthetic seed_smoke.sql fixture. The "
            "grounding_rate here measures the ratio of distinct fact_ids "
            "covered by fact_evidence rows IN THE FIXTURE — not BrainCore's "
            "grounding quality on a natural corpus. Do NOT cite this value "
            "as a representative grounding claim. The public README's "
            "grounding metric comes from a separate production-corpus "
            "benchmark against a naturally-populated BrainCore instance."
        ),
        "grounding_rate": rate,
        "total_cases": total,
        "grounded_cases": grounded,
        "source": "direct fact_evidence count",
        "notes": (
            "Computed directly from SELECT count(DISTINCT fact_id) FROM "
            "preserve.fact_evidence / SELECT count(*) FROM preserve.fact. "
            "The bun src/cli.ts eval --run subcommand is implemented but "
            "does not emit a grounding_rate metric in its eval_run.metrics "
            "JSONB payload; its aggregate metrics are entity F1, fact-count "
            "ratio, and root-cause / fix-summary match rates. See the "
            "module docstring for the full rationale."
        ),
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "python": sys.version.split()[0],
            "dsn_host": _public_dsn_host_label(dsn),
        },
    }

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, sort_keys=False)
        fh.write("\n")

    print(f"Wrote {OUTPUT_PATH}")
    print(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    run()
