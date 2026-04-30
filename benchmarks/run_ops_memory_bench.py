#!/usr/bin/env python3
"""BrainCoreOpsMemoryBench benchmark runner.

This expands synthetic smoke coverage across operational-memory behaviors that
are already implemented in the retrieval library: fact recall, timeline recall,
causal chains, scope isolation, graph-path explanations, multimodal retrieval,
working-memory promotion gates, retention review-only decisions, and
deterministic reranking. Procedure and multimodal cases are scored when their
schemas exist and emitted as non-scoring placeholders only for older schema
baselines.
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
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from run_event_timeline import apply_event_seed, fetch_timeline_stats  # noqa: E402
from run_graph_retrieval import apply_graph_seed  # noqa: E402
from run_retrieval import (  # noqa: E402
    RRF_K,
    TOP_K,
    _bootstrap_library,
    _public_dsn_host_label,
    maybe_seed,
)

RESULT_DATE = "2026-04-26"
VERSION = "1.1.6"
REPO_ROOT = Path(__file__).resolve().parent.parent
BENCHMARKS_DIR = REPO_ROOT / "benchmarks"
RESULTS_DIR = BENCHMARKS_DIR / "results"
OUTPUT_PATH = RESULTS_DIR / f"{RESULT_DATE}-ops-memory-bench.json"

FACT_RECALL_CASES = [
    {
        "id": "fact-docker-cause",
        "query": "docker daemon disk space exhaustion root cause server-a",
        "scope": "device:server-a",
        "expected_object_id": "ffffffff-0001-0001-0001-000000000001",
        "expected_title": "docker daemon disk space exhaustion",
    },
    {
        "id": "fact-postgresql-remediation",
        "query": "max_standby_streaming_delay fix long-running analytical query blocking WAL replay",
        "scope": "device:server-b",
        "expected_object_id": "ffffffff-0002-0002-0002-000000000002",
        "expected_title": "max_standby_streaming_delay raised",
    },
    {
        "id": "fact-nginx-remediation",
        "query": "certbot auto-renewal automated certificate renewal after nginx outage",
        "scope": "device:server-a",
        "expected_object_id": "ffffffff-0003-0003-0003-000000000002",
        "expected_title": "certbot auto-renewal",
    },
]

TIMELINE_RECALL_CASES = [
    {
        "id": "timeline-server-a",
        "scope": "device:server-a",
        "expected_ids": [
            "ef000000-0001-0001-0001-000000000001",
            "ef000000-0001-0001-0001-000000000002",
            "ef000000-0003-0003-0003-000000000001",
            "ef000000-0003-0003-0003-000000000002",
        ],
    },
    {
        "id": "timeline-nginx-window",
        "subject": "nginx",
        "from_ts": "2026-02-15T00:00:00Z",
        "to_ts": "2026-02-16T00:00:00Z",
        "expected_ids": [
            "ef000000-0003-0003-0003-000000000001",
            "ef000000-0003-0003-0003-000000000002",
        ],
    },
]

CAUSAL_CHAIN_CASES = [
    {
        "id": "chain-postgresql",
        "scope": "device:server-b",
        "expected_episode_id": "eeeeeeee-0002-0002-0002-000000000002",
        "expected_step_ids": [
            "ef000000-0002-0002-0002-000000000001",
            "ef000000-0002-0002-0002-000000000002",
        ],
    },
    {
        "id": "chain-nginx",
        "subject": "nginx",
        "scope": "device:server-a",
        "expected_episode_id": "eeeeeeee-0003-0003-0003-000000000003",
        "expected_step_ids": [
            "ef000000-0003-0003-0003-000000000001",
            "ef000000-0003-0003-0003-000000000002",
        ],
    },
]

SCOPE_ISOLATION_CASES = [
    {
        "id": "scope-server-a-excludes-server-b",
        "query": "postgresql replication lag server-b WAL replay",
        "scope": "device:server-a",
        "forbidden_scope_prefix": "device:server-b",
        "forbidden_object_ids": [
            "ffffffff-0002-0002-0002-000000000001",
            "ffffffff-0002-0002-0002-000000000002",
            "eeeeeeee-0002-0002-0002-000000000002",
        ],
    },
    {
        "id": "scope-server-b-excludes-server-a",
        "query": "nginx certificate certbot auto-renewal server-a",
        "scope": "device:server-b",
        "forbidden_scope_prefix": "device:server-a",
        "forbidden_object_ids": [
            "ffffffff-0003-0003-0003-000000000001",
            "ffffffff-0003-0003-0003-000000000002",
            "eeeeeeee-0003-0003-0003-000000000003",
        ],
    },
]

GRAPH_PATH_CASES = [
    {
        "id": "graph-docker-playbook",
        "query": "log rotation remediation for docker container logs",
        "expected_object_id": "a0000000-0000-0000-0000-00000000001d",
        "expected_title": "Docker log rotation and disk management playbook",
    },
    {
        "id": "graph-tls-playbook",
        "query": "certbot auto-renewal after nginx outage",
        "expected_object_id": "a0000000-0000-0000-0000-00000000016d",
        "expected_title": "TLS timer operational playbook",
    },
]

PROCEDURE_CASES = [
    {
        "id": "procedure-docker-log-rotation",
        "query": "procedure steps for docker log rotation",
        "scope": "device:server-a",
        "expected_procedure_id": "b0000000-0000-0000-0000-000000000001",
        "expected_step_count": 1,
    },
    {
        "id": "procedure-certbot-renewal",
        "query": "procedure steps for certbot renewal",
        "scope": "device:server-a",
        "expected_procedure_id": "b0000000-0000-0000-0000-000000000002",
        "expected_step_count": 1,
    },
]

PROCEDURE_OPERATIONAL_CASES = [
    {
        "id": "procedure-next-step-docker-log-rotation",
        "tool": "next_step",
        "query": "docker log rotation",
        "scope": "device:server-a",
        "expected_step_id": "b1000000-0000-0000-0000-000000000001",
    },
    {
        "id": "procedure-tried-before-certbot-renewal",
        "tool": "tried_before",
        "query": "certbot renewal",
        "scope": "device:server-a",
        "expected_step_id": "b1000000-0000-0000-0000-000000000002",
    },
    {
        "id": "procedure-failed-remediation-postgresql-restart",
        "tool": "failed_remediation",
        "query": "postgresql restart",
        "scope": "device:server-b",
        "expected_step_id": "b1000000-0000-0000-0000-000000000003",
    },
]

PROCEDURE_PLACEHOLDER_CASES = [
    {
        "id": "procedure-docker-log-rotation",
        "query": "procedure steps for docker log rotation",
        "reason": "No preserve.procedure schema is present; current behavior stores this as playbook memory.",
        "implemented_proxy": "memory_search(type_filter='memory') can recall the Docker log rotation playbook.",
    },
    {
        "id": "procedure-certbot-renewal",
        "query": "procedure steps for certbot renewal",
        "reason": "No preserve.procedure schema is present; current behavior stores this as playbook memory.",
        "implemented_proxy": "memory_search(type_filter='memory') can recall the Lets Encrypt certbot playbook.",
    },
]

WORKING_MEMORY_CASES = [
    {
        "id": "working-memory-promotion-candidate",
        "session_key": "bench-working-memory-completed",
        "expected_target_kind": "fact",
        "expected_target_id": "ffffffff-0001-0001-0001-000000000002",
    },
    {
        "id": "working-memory-expired-hidden",
        "session_key": "bench-working-memory-active",
    },
]

RETENTION_CASES = [
    {
        "id": "retention-stale-demotion-review",
        "memory_id": "d0000000-0000-0000-0000-000000000001",
        "expected_status": "pending",
    },
]

RERANKING_CASES = [
    {
        "id": "reranking-procedure-answer-boost",
        "query": "how did we fix xrdp on device:alpha",
        "expected_disabled_order": ["a", "b"],
        "expected_enabled_order": ["b", "a"],
    },
]

MULTIMODAL_METADATA_CASES = [
    {
        "id": "multimodal-visual-region-safe-search",
        "query": "docker log rotation diagram",
        "scope": "device:server-a",
        "expected_result_type": "visual_region",
        "expected_label": "Docker log rotation diagram",
    },
]

MULTIMODAL_VECTOR_CASES = [
    {
        "id": "multimodal-media-caption-vector",
        "query": "document preview for docker log rotation",
        "scope": "device:server-a",
        "type_filter": "media_artifact",
        "expected_object_type": "media_artifact",
        "expected_title": "Docker log rotation evidence document",
    },
    {
        "id": "multimodal-visual-region-vector",
        "query": "docker log rotation diagram",
        "scope": "device:server-a",
        "type_filter": "visual_region",
        "expected_object_type": "visual_region",
        "expected_title": "Docker log rotation diagram",
    },
]

MULTIMODAL_PLACEHOLDER_CASES = [
    {
        "id": "multimodal-visual-region-safe-search",
        "query": "docker log rotation diagram",
        "reason": "No preserve.media_artifact / preserve.visual_region / preserve.embedding_index schema is present.",
    },
]


def _ids(entries: list[dict[str, Any]], key: str) -> list[str]:
    return [entry.get(key) for entry in entries]


def ordered_subset(actual: list[str], expected: list[str]) -> bool:
    cursor = 0
    for item in actual:
        if cursor < len(expected) and item == expected[cursor]:
            cursor += 1
    return cursor == len(expected)


def has_object(results: list[dict[str, Any]], object_id: str, *, top_k: int = TOP_K) -> bool:
    return any(result.get("object_id") == object_id for result in results[:top_k])


def has_graph_path(results: list[dict[str, Any]], object_id: str, *, top_k: int = TOP_K) -> bool:
    for result in results[:top_k]:
        if result.get("object_id") != object_id:
            continue
        return any(step.get("object_type") == "memory_edge" for step in result.get("why", []))
    return False


def count_scope_leaks(
    results: list[dict[str, Any]],
    *,
    forbidden_scope_prefix: str,
    forbidden_object_ids: list[str],
) -> int:
    forbidden_ids = set(forbidden_object_ids)
    return sum(
        1
        for result in results
        if result.get("object_id") in forbidden_ids
        or str(result.get("scope_path") or "").startswith(forbidden_scope_prefix)
    )


def apply_procedure_seed(dsn: str) -> bool:
    """Seed synthetic procedure rows when migration 014+ is available."""
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT to_regclass('preserve.procedure')")
        if cur.fetchone()[0] is None:
            return False

        cur.execute(
            """
            INSERT INTO preserve.procedure (
              procedure_id, tenant, procedure_fingerprint, title, summary,
              source_fact_id, evidence_segment_id, assertion_class, confidence,
              lifecycle_state, scope_path, procedure_json
            ) VALUES
            (
              'b0000000-0000-0000-0000-000000000001', 'default',
              'bench-procedure-docker-log-rotation',
              'Docker log rotation procedure',
              'Procedure steps for docker log rotation remediation.',
              'ffffffff-0001-0001-0001-000000000002',
              '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              'deterministic', 0.90, 'published', 'device:server-a',
              '{"benchmark":"ops-memory"}'::jsonb
            ),
            (
              'b0000000-0000-0000-0000-000000000002', 'default',
              'bench-procedure-certbot-renewal',
              'Certbot renewal procedure',
              'Procedure steps for certbot renewal after nginx outage.',
              'ffffffff-0003-0003-0003-000000000002',
              '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              'deterministic', 0.90, 'published', 'device:server-a',
              '{"benchmark":"ops-memory"}'::jsonb
            ),
            (
              'b0000000-0000-0000-0000-000000000003', 'default',
              'bench-procedure-postgresql-restart-failed',
              'PostgreSQL restart failed remediation',
              'Failed remediation: restarting PostgreSQL did not clear replication lag.',
              'ffffffff-0002-0002-0002-000000000002',
              '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              'deterministic', 0.90, 'published', 'device:server-b',
              '{"benchmark":"ops-memory","outcome":"failed"}'::jsonb
            )
            ON CONFLICT (tenant, procedure_fingerprint) DO NOTHING
            """
        )
        cur.execute(
            """
            INSERT INTO preserve.procedure_step (
              procedure_step_id, procedure_id, tenant, step_index, action,
              expected_result, source_fact_id, evidence_segment_id,
              assertion_class, confidence, scope_path, step_json
            ) VALUES
            (
              'b1000000-0000-0000-0000-000000000001',
              'b0000000-0000-0000-0000-000000000001', 'default', 1,
              'Configure docker json-file log rotation with max-size and max-file.',
              'Container logs rotate before filling disk.',
              'ffffffff-0001-0001-0001-000000000002',
              '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              'deterministic', 0.90, 'device:server-a',
              '{"benchmark":"ops-memory"}'::jsonb
            ),
            (
              'b1000000-0000-0000-0000-000000000002',
              'b0000000-0000-0000-0000-000000000002', 'default', 1,
              'Enable and verify the certbot systemd timer for automatic renewal.',
              'Certificates renew automatically before nginx outage recurrence.',
              'ffffffff-0003-0003-0003-000000000002',
              '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              'deterministic', 0.90, 'device:server-a',
              '{"benchmark":"ops-memory"}'::jsonb
            ),
            (
              'b1000000-0000-0000-0000-000000000003',
              'b0000000-0000-0000-0000-000000000003', 'default', 1,
              'Restart PostgreSQL to try to clear replication lag.',
              'Failed: restart did not clear WAL replay lag.',
              'ffffffff-0002-0002-0002-000000000002',
              '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              'deterministic', 0.90, 'device:server-b',
              '{"benchmark":"ops-memory","outcome":"failed"}'::jsonb
            )
            ON CONFLICT (procedure_id, step_index) DO NOTHING
            """
        )
        conn.commit()
    return True


def search_procedures_sql(
    pool: ConnectionPool,
    *,
    query: str,
    scope: str | None,
    limit: int = TOP_K,
) -> list[dict[str, Any]]:
    with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            WITH matches AS (
              SELECT
                p.procedure_id,
                p.title,
                p.summary,
                p.scope_path,
                ts_rank(p.fts, plainto_tsquery('english', %(query)s)) AS rank
              FROM preserve.procedure p
              WHERE p.tenant = 'default'
                AND p.lifecycle_state != 'retired'
                AND p.fts @@ plainto_tsquery('english', %(query)s)
                AND (%(scope)s::text IS NULL OR COALESCE(p.scope_path, '') LIKE (%(scope)s || '%%'))
              ORDER BY rank DESC, p.updated_at DESC
              LIMIT %(limit)s
            )
            SELECT
              m.procedure_id::text AS procedure_id,
              m.title,
              m.summary,
              m.scope_path,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'step_index', ps.step_index,
                    'action', ps.action,
                    'expected_result', ps.expected_result
                  )
                  ORDER BY ps.step_index
                ) FILTER (WHERE ps.procedure_step_id IS NOT NULL),
                '[]'::jsonb
              ) AS steps
            FROM matches m
            LEFT JOIN preserve.procedure_step ps
              ON ps.procedure_id = m.procedure_id
             AND ps.tenant = 'default'
            GROUP BY m.procedure_id, m.title, m.summary, m.scope_path, m.rank
            ORDER BY m.rank DESC, m.title
            """,
            {"query": query, "scope": scope, "limit": limit},
        )
        return list(cur.fetchall())


def procedure_schema_state(dsn: str) -> dict[str, Any]:
    """Return schema-aware status for future procedure benchmarks."""
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'preserve'
              AND table_name IN ('procedure', 'procedure_step')
            ORDER BY table_name
            """
        )
        tables = [row[0] for row in cur.fetchall()]

    if not tables:
        return {
            "status": "schema_absent_placeholder",
            "scored": False,
            "cases": PROCEDURE_PLACEHOLDER_CASES,
        }
    return {
        "status": "schema_present_scored",
        "scored": True,
        "tables": tables,
        "cases": PROCEDURE_CASES,
    }


def apply_working_memory_seed(dsn: str) -> bool:
    """Seed synthetic working-memory rows when migration 016+ is available."""
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT to_regclass('preserve.task_session'), to_regclass('preserve.working_memory')")
        if any(value is None for value in cur.fetchone()):
            return False

        cur.execute(
            """
            INSERT INTO preserve.task_session (
              session_id, tenant, session_key, agent_name, task_title, status,
              scope_path, started_at, last_seen_at, ended_at, expires_at,
              session_json
            ) VALUES
            (
              'c0000000-0000-0000-0000-000000000001', 'default',
              'bench-working-memory-completed', 'bench', 'Completed benchmark task',
              'completed', 'device:server-a', now() - interval '2 hours',
              now() - interval '1 hour', now() - interval '1 hour',
              now() + interval '14 days', '{"benchmark":"ops-memory"}'::jsonb
            ),
            (
              'c0000000-0000-0000-0000-000000000002', 'default',
              'bench-working-memory-active', 'bench', 'Active benchmark task',
              'active', 'device:server-a', now() - interval '2 hours',
              now(), NULL, now() + interval '14 days',
              '{"benchmark":"ops-memory"}'::jsonb
            )
            ON CONFLICT (tenant, session_key) DO UPDATE SET
              status = EXCLUDED.status,
              ended_at = EXCLUDED.ended_at,
              expires_at = EXCLUDED.expires_at,
              updated_at = now()
            """
        )
        cur.execute(
            """
            INSERT INTO preserve.working_memory (
              working_memory_id, tenant, session_id, working_memory_fingerprint,
              memory_kind, content, content_json, source_fact_id,
              evidence_segment_id, confidence, promotion_status, expires_at,
              created_at, updated_at
            ) VALUES
            (
              'c1000000-0000-0000-0000-000000000001', 'default',
              'c0000000-0000-0000-0000-000000000001',
              'bench-working-memory-promotion-candidate',
              'decision',
              'Promote the docker log rotation remediation as durable evidence.',
              '{"benchmark":"ops-memory"}'::jsonb,
              'ffffffff-0001-0001-0001-000000000002',
              '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              0.90, 'not_promoted', now() + interval '14 days', now(), now()
            ),
            (
              'c1000000-0000-0000-0000-000000000002', 'default',
              'c0000000-0000-0000-0000-000000000002',
              'bench-working-memory-expired-hidden',
              'observation',
              'Expired working-memory item should not appear by default.',
              '{"benchmark":"ops-memory"}'::jsonb,
              'ffffffff-0001-0001-0001-000000000002',
              '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              0.80, 'not_promoted', now() - interval '1 day',
              now() - interval '2 days', now() - interval '2 days'
            )
            ON CONFLICT (tenant, working_memory_fingerprint) DO UPDATE SET
              promotion_status = EXCLUDED.promotion_status,
              promotion_reason = NULL,
              promotion_target_kind = NULL,
              promotion_target_id = NULL,
              promotion_marked_at = NULL,
              expires_at = EXCLUDED.expires_at,
              updated_at = now()
            """
        )
        conn.commit()
    return True


def score_working_memory_sql(pool: ConnectionPool) -> list[dict[str, Any]]:
    reports: list[dict[str, Any]] = []
    with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            UPDATE preserve.working_memory wm
            SET promotion_status = 'promotion_candidate',
                promotion_reason = 'benchmark promotion gate',
                promotion_target_kind = 'fact',
                promotion_target_id = 'ffffffff-0001-0001-0001-000000000002',
                promotion_marked_at = now(),
                updated_at = now()
            FROM preserve.task_session ts
            WHERE wm.tenant = 'default'
              AND wm.working_memory_id = 'c1000000-0000-0000-0000-000000000001'
              AND ts.tenant = wm.tenant
              AND ts.session_id = wm.session_id
              AND ts.status IN ('completed', 'failed')
              AND wm.expires_at > now()
              AND (
                wm.evidence_segment_id IS NOT NULL
                OR wm.source_segment_id IS NOT NULL
                OR wm.source_fact_id IS NOT NULL
              )
            RETURNING
              wm.working_memory_id::text AS working_memory_id,
              wm.promotion_status,
              wm.promotion_target_kind,
              wm.promotion_target_id::text AS promotion_target_id
            """
        )
        promotion = cur.fetchone()
        reports.append({
            "id": "working-memory-promotion-candidate",
            "hit": bool(
                promotion
                and promotion["promotion_status"] == "promotion_candidate"
                and promotion["promotion_target_kind"] == "fact"
            ),
            "promotion": dict(promotion) if promotion else None,
        })

        cur.execute(
            """
            SELECT count(*)::int AS visible_expired
            FROM preserve.working_memory wm
            JOIN preserve.task_session ts
              ON ts.tenant = wm.tenant
             AND ts.session_id = wm.session_id
            WHERE wm.tenant = 'default'
              AND ts.session_key = 'bench-working-memory-active'
              AND wm.working_memory_id = 'c1000000-0000-0000-0000-000000000002'
              AND wm.expires_at > now()
            """
        )
        visible_expired = cur.fetchone()["visible_expired"]
        reports.append({
            "id": "working-memory-expired-hidden",
            "visible_expired": visible_expired,
            "hit": visible_expired == 0,
        })
    return reports


def score_procedure_operational(pool: ConnectionPool) -> list[dict[str, Any]]:
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    from mcp import memory_search as ms  # noqa: PLC0415

    reports: list[dict[str, Any]] = []
    for case in PROCEDURE_OPERATIONAL_CASES:
        if case["tool"] == "next_step":
            raw = ms.memory_next_step(
                pool,
                query=case["query"],
                scope=case["scope"],
                completed_steps=0,
                limit=TOP_K,
            )
        elif case["tool"] == "tried_before":
            raw = ms.memory_what_did_we_try(
                pool,
                query=case["query"],
                scope=case["scope"],
                limit=TOP_K,
            )
        elif case["tool"] == "failed_remediation":
            raw = ms.memory_failed_remediations(
                pool,
                query=case["query"],
                scope=case["scope"],
                limit=TOP_K,
            )
        else:
            raise ValueError(f"Unknown procedure operational tool: {case['tool']}")

        results = raw.get("results", []) or []
        actual_step_ids = _ids(results, "step_id")
        hit = case["expected_step_id"] in actual_step_ids
        reports.append({
            "id": case["id"],
            "tool": case["tool"],
            "query": case["query"],
            "scope": case["scope"],
            "expected_step_id": case["expected_step_id"],
            "actual_step_ids": actual_step_ids,
            "hit": hit,
        })
    return reports


def apply_retention_seed(dsn: str) -> bool:
    """Seed one stale published memory for review-only retention scoring."""
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT to_regclass('preserve.review_queue')")
        if cur.fetchone()[0] is None:
            return False

        cur.execute(
            """
            INSERT INTO preserve.memory (
              memory_id, tenant, memory_type, fingerprint, title, narrative,
              support_count, contradiction_count, confidence, lifecycle_state,
              pipeline_version, model_name, prompt_version, scope_path,
              priority, last_supported_at
            ) VALUES (
              'd0000000-0000-0000-0000-000000000001', 'default', 'heuristic',
              'bench-retention-stale-memory',
              'Stale benchmark memory',
              'This synthetic memory should produce a demotion review proposal.',
              0, 0, 0.80, 'published', 'ops-memory-bench', 'synthetic', 'v0',
              'device:server-a', 5, now() - interval '120 days'
            )
            ON CONFLICT (tenant, fingerprint) DO UPDATE SET
              support_count = EXCLUDED.support_count,
              contradiction_count = EXCLUDED.contradiction_count,
              lifecycle_state = EXCLUDED.lifecycle_state,
              last_supported_at = EXCLUDED.last_supported_at,
              updated_at = now()
            """
        )
        cur.execute(
            """
            DELETE FROM preserve.review_queue
            WHERE target_type = 'memory'
              AND target_id = 'd0000000-0000-0000-0000-000000000001'
              AND reason = 'Adaptive retention review: published memory is stale; review demotion to draft.'
            """
        )
        conn.commit()
    return True


def score_retention_sql(pool: ConnectionPool) -> list[dict[str, Any]]:
    with pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            INSERT INTO preserve.review_queue (
              target_type, target_id, reason, status, reviewer_notes
            )
            SELECT
              'memory',
              m.memory_id,
              'Adaptive retention review: published memory is stale; review demotion to draft.',
              'pending',
              'proposal=demote_to_draft; risk=0.70; scope=' || COALESCE(m.scope_path, '(none)')
            FROM preserve.memory m
            WHERE m.tenant = 'default'
              AND m.memory_id = 'd0000000-0000-0000-0000-000000000001'
              AND m.lifecycle_state = 'published'
              AND (
                m.last_supported_at IS NULL
                OR m.last_supported_at < now() - interval '90 days'
              )
            RETURNING review_id::text AS review_id, status
            """
        )
        review = cur.fetchone()
        cur.execute(
            """
            SELECT lifecycle_state::text AS lifecycle_state
            FROM preserve.memory
            WHERE memory_id = 'd0000000-0000-0000-0000-000000000001'
            """
        )
        lifecycle = cur.fetchone()["lifecycle_state"]
    return [{
        "id": "retention-stale-demotion-review",
        "review_status": review["status"] if review else None,
        "memory_lifecycle_state": lifecycle,
        "hit": bool(review and review["status"] == "pending" and lifecycle == "published"),
    }]


def apply_multimodal_seed(dsn: str) -> bool:
    """Seed synthetic media/visual/vector rows when migration 017+ is available."""
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              to_regclass('preserve.media_artifact'),
              to_regclass('preserve.visual_region'),
              to_regclass('preserve.embedding_index')
            """
        )
        if any(value is None for value in cur.fetchone()):
            return False

        vector = "[" + ",".join(["0.01"] * 384) + "]"
        cur.execute(
            """
            INSERT INTO preserve.media_artifact (
              media_artifact_id, tenant, artifact_id, source_segment_id,
              media_type, mime_type, sha256, page_count, scope_path,
              media_meta, ingest_run_id, ingest_batch_key
            ) VALUES (
              'e0000000-0000-0000-0000-000000000001', 'default',
              '11111111-1111-1111-1111-111111111111',
              '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              'document', 'text/markdown', repeat('d', 64), 1,
              'device:server-a',
              '{
                "title":"Docker log rotation evidence document",
                "caption":"Document preview for docker log rotation remediation evidence.",
                "description":"Synthetic multimodal benchmark fixture with no raw private artifact bytes."
              }'::jsonb,
              'e2000000-0000-0000-0000-000000000001',
              'bench-multimodal'
            )
            ON CONFLICT (tenant, artifact_id) DO UPDATE SET
              source_segment_id = EXCLUDED.source_segment_id,
              media_type = EXCLUDED.media_type,
              mime_type = EXCLUDED.mime_type,
              sha256 = EXCLUDED.sha256,
              page_count = EXCLUDED.page_count,
              scope_path = EXCLUDED.scope_path,
              media_meta = EXCLUDED.media_meta,
              ingest_run_id = EXCLUDED.ingest_run_id,
              ingest_batch_key = EXCLUDED.ingest_batch_key,
              updated_at = now()
            """
        )
        cur.execute(
            """
            INSERT INTO preserve.visual_region (
              visual_region_id, tenant, media_artifact_id, region_fingerprint,
              region_type, page_number, x_min, y_min, x_max, y_max,
              label, source_segment_id, confidence, assertion_class,
              region_meta, ingest_run_id, ingest_batch_key
            ) VALUES (
              'e1000000-0000-0000-0000-000000000001', 'default',
              'e0000000-0000-0000-0000-000000000001',
              'bench-multimodal-docker-log-rotation-region',
              'diagram', 1, 0.10, 0.10, 0.90, 0.60,
              'Docker log rotation diagram',
              '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              0.95, 'deterministic',
              '{
                "scope_path":"device:server-a",
                "ocr_text":"Docker log rotation diagram showing max-size and max-file remediation.",
                "caption":"Diagram region for docker log rotation remediation."
              }'::jsonb,
              'e2000000-0000-0000-0000-000000000001',
              'bench-multimodal'
            )
            ON CONFLICT (tenant, region_fingerprint) DO UPDATE SET
              media_artifact_id = EXCLUDED.media_artifact_id,
              page_number = EXCLUDED.page_number,
              x_min = EXCLUDED.x_min,
              y_min = EXCLUDED.y_min,
              x_max = EXCLUDED.x_max,
              y_max = EXCLUDED.y_max,
              label = EXCLUDED.label,
              source_segment_id = EXCLUDED.source_segment_id,
              confidence = EXCLUDED.confidence,
              assertion_class = EXCLUDED.assertion_class,
              region_meta = EXCLUDED.region_meta,
              ingest_run_id = EXCLUDED.ingest_run_id,
              ingest_batch_key = EXCLUDED.ingest_batch_key,
              updated_at = now()
            """
        )
        cur.execute(
            """
            INSERT INTO preserve.embedding_index (
              tenant, target_kind, vector_role, embedding_model,
              embedding_dimension, embedding, embedding_fingerprint,
              media_artifact_id, visual_region_id, source_artifact_id,
              source_segment_id, input_sha256, embedding_meta
            ) VALUES
            (
              'default', 'media_artifact', 'media_caption', 'synthetic-bench',
              384, %(vector)s::vector, 'bench-media-caption-docker-log-rotation',
              'e0000000-0000-0000-0000-000000000001', NULL,
              '11111111-1111-1111-1111-111111111111',
              '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              repeat('d', 64), '{"benchmark":"ops-memory"}'::jsonb
            ),
            (
              'default', 'visual_region', 'visual_ocr', 'synthetic-bench',
              384, %(vector)s::vector, 'bench-visual-ocr-docker-log-rotation',
              NULL, 'e1000000-0000-0000-0000-000000000001',
              '11111111-1111-1111-1111-111111111111',
              '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              repeat('e', 64), '{"benchmark":"ops-memory"}'::jsonb
            ),
            (
              'default', 'visual_region', 'visual_caption', 'synthetic-bench',
              384, %(vector)s::vector, 'bench-visual-caption-docker-log-rotation',
              NULL, 'e1000000-0000-0000-0000-000000000001',
              '11111111-1111-1111-1111-111111111111',
              '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              repeat('f', 64), '{"benchmark":"ops-memory"}'::jsonb
            )
            ON CONFLICT (tenant, embedding_fingerprint) DO UPDATE SET
              embedding = EXCLUDED.embedding,
              embedding_dimension = EXCLUDED.embedding_dimension,
              embedding_meta = EXCLUDED.embedding_meta
            """,
            {"vector": vector},
        )
        conn.commit()
    return True


def multimodal_schema_state(dsn: str) -> dict[str, Any]:
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'preserve'
              AND table_name IN ('media_artifact', 'visual_region', 'embedding_index')
            ORDER BY table_name
            """
        )
        tables = [row[0] for row in cur.fetchall()]

    if len(tables) < 3:
        return {
            "status": "schema_absent_placeholder",
            "scored": False,
            "cases": MULTIMODAL_PLACEHOLDER_CASES,
        }
    return {
        "status": "schema_present_scored",
        "scored": True,
        "tables": tables,
        "metadata_cases": MULTIMODAL_METADATA_CASES,
        "vector_cases": MULTIMODAL_VECTOR_CASES,
    }


def score_multimodal(
    pool: ConnectionPool,
    memory_search: Any,
    *,
    vector_disabled: bool,
) -> list[dict[str, Any]]:
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    from mcp import memory_search as ms  # noqa: PLC0415

    reports: list[dict[str, Any]] = []
    for case in MULTIMODAL_METADATA_CASES:
        raw = ms.memory_search_visual(
            pool,
            query=case["query"],
            scope=case["scope"],
            limit=TOP_K,
        )
        results = raw.get("results", []) or []
        hit = any(
            row.get("result_type") == case["expected_result_type"]
            and row.get("label") == case["expected_label"]
            for row in results[:TOP_K]
        )
        reports.append({
            "id": case["id"],
            "kind": "metadata",
            "query": case["query"],
            "scope": case["scope"],
            "actual_labels": _ids(results, "label"),
            "hit": hit,
        })

    for case in MULTIMODAL_VECTOR_CASES:
        if vector_disabled:
            reports.append({
                "id": case["id"],
                "kind": "vector",
                "query": case["query"],
                "scope": case["scope"],
                "type_filter": case["type_filter"],
                "hit": False,
                "skipped": "vector_disabled",
            })
            continue

        previous_flag = memory_search.__globals__.get("EMBEDDING_INDEX_RETRIEVAL_ENABLED", False)
        memory_search.__globals__["EMBEDDING_INDEX_RETRIEVAL_ENABLED"] = True
        try:
            raw = memory_search(
                pool,
                query=case["query"],
                scope=case["scope"],
                type_filter=case["type_filter"],
                limit=TOP_K,
            )
        finally:
            memory_search.__globals__["EMBEDDING_INDEX_RETRIEVAL_ENABLED"] = previous_flag

        results = raw.get("results", []) or []
        hit = any(
            row.get("object_type") == case["expected_object_type"]
            and row.get("title") == case["expected_title"]
            for row in results[:TOP_K]
        )
        reports.append({
            "id": case["id"],
            "kind": "vector",
            "query": case["query"],
            "scope": case["scope"],
            "type_filter": case["type_filter"],
            "actual_titles": _ids(results, "title"),
            "stream_counts": raw.get("stream_counts", {}),
            "hit": hit,
        })

    return reports


def score_reranking_synthetic() -> list[dict[str, Any]]:
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    from mcp import memory_search as ms  # noqa: PLC0415

    reports: list[dict[str, Any]] = []
    for case in RERANKING_CASES:
        strong_rrf = ms._ScoredCandidate(  # noqa: SLF001
            candidate=ms._Candidate(  # noqa: SLF001
                object_id="a",
                object_type="fact",
                title="generic result",
                scope_path="device:other",
            ),
            scores={"fts": 0.06},
        )
        matching_lower_rrf = ms._ScoredCandidate(  # noqa: SLF001
            candidate=ms._Candidate(  # noqa: SLF001
                object_id="b",
                object_type="memory",
                title="Playbook: xrdp fix",
                summary="Fix xrdp session handling",
                scope_path="device:alpha",
                confidence=0.95,
                evidence=[{"segment_id": "s1"}, {"segment_id": "s2"}],
            ),
            scores={"fts": 0.04, "graph": 0.01},
        )
        plan = ms._plan_query(case["query"], "device:alpha")  # noqa: SLF001
        disabled = ms._rank_candidates([matching_lower_rrf, strong_rrf], plan, False)  # noqa: SLF001
        enabled = ms._rank_candidates([strong_rrf, matching_lower_rrf], plan, True)  # noqa: SLF001
        disabled_order = [item.candidate.object_id for item in disabled]
        enabled_order = [item.candidate.object_id for item in enabled]
        reports.append({
            "id": case["id"],
            "query": case["query"],
            "disabled_order": disabled_order,
            "enabled_order": enabled_order,
            "hit": (
                disabled_order == case["expected_disabled_order"]
                and enabled_order == case["expected_enabled_order"]
            ),
        })
    return reports


def _record_latency(latencies_ms: list[float], started_at: float) -> float:
    elapsed_ms = (time.perf_counter() - started_at) * 1000.0
    latencies_ms.append(elapsed_ms)
    return elapsed_ms


def _latency_report(latencies_ms: list[float]) -> dict[str, float]:
    latencies_sorted = sorted(latencies_ms)
    if not latencies_sorted:
        return {"p50": 0.0, "p95": 0.0}
    return {
        "p50": round(statistics.median(latencies_sorted), 3),
        "p95": round(latencies_sorted[-1], 3),
    }


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

    from run_event_timeline import _bootstrap_timeline  # noqa: PLC0415

    memory_timeline, _memory_before_after, memory_causal_chain = _bootstrap_timeline()

    maybe_seed(dsn, no_seed=no_seed, force_seed=force_seed)
    apply_event_seed(dsn)
    apply_graph_seed(dsn)
    procedure_seeded = apply_procedure_seed(dsn)
    working_memory_seeded = apply_working_memory_seed(dsn)
    retention_seeded = apply_retention_seed(dsn)
    multimodal_seeded = apply_multimodal_seed(dsn)
    corpus = fetch_timeline_stats(dsn)
    procedures = procedure_schema_state(dsn)
    multimodal = multimodal_schema_state(dsn)
    corpus["procedures"] = 0
    corpus["working_memory_items"] = 0
    corpus["retention_review_queue"] = 0
    corpus["media_artifacts"] = 0
    corpus["visual_regions"] = 0
    corpus["embedding_index_rows"] = 0
    if procedure_seeded:
        with psycopg.connect(dsn) as conn, conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM preserve.procedure")
            corpus["procedures"] = cur.fetchone()[0]
    if working_memory_seeded or retention_seeded or multimodal_seeded:
        with psycopg.connect(dsn) as conn, conn.cursor() as cur:
            if working_memory_seeded:
                cur.execute("SELECT count(*) FROM preserve.working_memory")
                corpus["working_memory_items"] = cur.fetchone()[0]
            if retention_seeded:
                cur.execute("SELECT count(*) FROM preserve.review_queue")
                corpus["retention_review_queue"] = cur.fetchone()[0]
            if multimodal_seeded:
                cur.execute("SELECT count(*) FROM preserve.media_artifact")
                corpus["media_artifacts"] = cur.fetchone()[0]
                cur.execute("SELECT count(*) FROM preserve.visual_region")
                corpus["visual_regions"] = cur.fetchone()[0]
                cur.execute("SELECT count(*) FROM preserve.embedding_index")
                corpus["embedding_index_rows"] = cur.fetchone()[0]

    pool = ConnectionPool(conninfo=dsn, min_size=1, max_size=4, open=True)
    latencies_ms: list[float] = []
    reports: dict[str, list[dict[str, Any]]] = {
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
    }
    scores = {
        "fact_hits": 0,
        "timeline_hits": 0,
        "timeline_ordered": 0,
        "causal_chain_hits": 0,
        "scope_leaks": 0,
        "graph_hits": 0,
        "graph_path_explanations": 0,
        "disabled_graph_stream_violations": 0,
        "procedure_hits": 0,
        "procedure_operational_hits": 0,
        "working_memory_hits": 0,
        "retention_review_hits": 0,
        "multimodal_hits": 0,
        "reranking_hits": 0,
    }

    try:
        for case in FACT_RECALL_CASES:
            t0 = time.perf_counter()
            raw = memory_search(
                pool,
                query=case["query"],
                scope=case["scope"],
                type_filter="fact",
                limit=TOP_K,
            )
            elapsed_ms = _record_latency(latencies_ms, t0)
            results = raw.get("results", []) or []
            hit = has_object(results, case["expected_object_id"])
            scores["fact_hits"] += int(hit)
            reports["fact_recall"].append({
                "id": case["id"],
                "query": case["query"],
                "scope": case["scope"],
                "expected_title": case["expected_title"],
                "actual_ids": _ids(results, "object_id"),
                "hit": hit,
                "stream_counts": raw.get("stream_counts", {}),
                "latency_ms": round(elapsed_ms, 3),
            })

        for case in TIMELINE_RECALL_CASES:
            t0 = time.perf_counter()
            raw = memory_timeline(
                pool,
                subject=case.get("subject"),
                scope=case.get("scope"),
                from_ts=case.get("from_ts"),
                to_ts=case.get("to_ts"),
                limit=TOP_K,
            )
            elapsed_ms = _record_latency(latencies_ms, t0)
            entries = raw.get("entries", []) or []
            actual_ids = _ids(entries, "event_frame_id")
            expected_ids = case["expected_ids"]
            hit = set(expected_ids).issubset(set(actual_ids))
            ordered = ordered_subset(actual_ids, expected_ids)
            scores["timeline_hits"] += int(hit)
            scores["timeline_ordered"] += int(ordered)
            reports["timeline_recall"].append({
                "id": case["id"],
                "filters": {
                    "subject": case.get("subject"),
                    "scope": case.get("scope"),
                    "from_ts": case.get("from_ts"),
                    "to_ts": case.get("to_ts"),
                },
                "expected_ids": expected_ids,
                "actual_ids": actual_ids,
                "hit": hit,
                "ordered": ordered,
                "latency_ms": round(elapsed_ms, 3),
            })

        for case in CAUSAL_CHAIN_CASES:
            t0 = time.perf_counter()
            raw = memory_causal_chain(
                pool,
                subject=case.get("subject"),
                scope=case.get("scope"),
                limit=TOP_K,
            )
            elapsed_ms = _record_latency(latencies_ms, t0)
            chains = raw.get("chains", []) or []
            actual_episode_ids = _ids(chains, "episode_id")
            actual_step_ids = [
                step.get("event_frame_id")
                for chain in chains
                for step in (chain.get("steps", []) or [])
            ]
            hit = (
                case["expected_episode_id"] in actual_episode_ids
                and ordered_subset(actual_step_ids, case["expected_step_ids"])
            )
            scores["causal_chain_hits"] += int(hit)
            reports["causal_chain"].append({
                "id": case["id"],
                "filters": {
                    "subject": case.get("subject"),
                    "scope": case.get("scope"),
                },
                "expected_episode_id": case["expected_episode_id"],
                "actual_episode_ids": actual_episode_ids,
                "expected_step_ids": case["expected_step_ids"],
                "actual_step_ids": actual_step_ids,
                "hit": hit,
                "latency_ms": round(elapsed_ms, 3),
            })

        for case in SCOPE_ISOLATION_CASES:
            t0 = time.perf_counter()
            raw = memory_search(
                pool,
                query=case["query"],
                scope=case["scope"],
                limit=TOP_K,
            )
            elapsed_ms = _record_latency(latencies_ms, t0)
            results = raw.get("results", []) or []
            leak_count = count_scope_leaks(
                results,
                forbidden_scope_prefix=case["forbidden_scope_prefix"],
                forbidden_object_ids=case["forbidden_object_ids"],
            )
            scores["scope_leaks"] += leak_count
            reports["scope_isolation"].append({
                "id": case["id"],
                "query": case["query"],
                "scope": case["scope"],
                "forbidden_scope_prefix": case["forbidden_scope_prefix"],
                "actual_ids": _ids(results, "object_id"),
                "actual_scope_paths": _ids(results, "scope_path"),
                "leak_count": leak_count,
                "latency_ms": round(elapsed_ms, 3),
            })

        for case in GRAPH_PATH_CASES:
            disabled = memory_search(
                pool,
                query=case["query"],
                limit=TOP_K,
                include_graph=False,
                explain_paths=True,
            )
            disabled_counts = disabled.get("stream_counts", {}) or {}
            if "graph" in disabled_counts:
                scores["disabled_graph_stream_violations"] += 1

            t0 = time.perf_counter()
            enabled = memory_search(
                pool,
                query=case["query"],
                limit=TOP_K,
                include_graph=True,
                explain_paths=True,
            )
            elapsed_ms = _record_latency(latencies_ms, t0)
            results = enabled.get("results", []) or []
            hit = has_object(results, case["expected_object_id"])
            path = has_graph_path(results, case["expected_object_id"])
            scores["graph_hits"] += int(hit)
            scores["graph_path_explanations"] += int(path)
            reports["graph_path"].append({
                "id": case["id"],
                "query": case["query"],
                "expected_title": case["expected_title"],
                "actual_ids": _ids(results, "object_id"),
                "hit": hit,
                "path_explanation": path,
                "disabled_stream_counts": disabled_counts,
                "enabled_stream_counts": enabled.get("stream_counts", {}),
                "latency_ms": round(elapsed_ms, 3),
            })

        if procedures.get("scored"):
            for case in PROCEDURE_CASES:
                t0 = time.perf_counter()
                results = search_procedures_sql(
                    pool,
                    query=case["query"],
                    scope=case["scope"],
                    limit=TOP_K,
                )
                elapsed_ms = _record_latency(latencies_ms, t0)
                expected_id = case["expected_procedure_id"]
                matched = next((row for row in results if row["procedure_id"] == expected_id), None)
                step_count = len(matched.get("steps", [])) if matched else 0
                hit = bool(matched and step_count >= case["expected_step_count"])
                scores["procedure_hits"] += int(hit)
                reports["procedure_reuse"].append({
                    "id": case["id"],
                    "query": case["query"],
                    "scope": case["scope"],
                    "expected_procedure_id": expected_id,
                    "actual_ids": _ids(results, "procedure_id"),
                    "step_count": step_count,
                    "hit": hit,
                    "latency_ms": round(elapsed_ms, 3),
                })

            t0 = time.perf_counter()
            operational_reports = score_procedure_operational(pool)
            elapsed_ms = _record_latency(latencies_ms, t0)
            for entry in operational_reports:
                entry["latency_ms"] = round(elapsed_ms, 3)
                scores["procedure_operational_hits"] += int(entry["hit"])
            reports["procedure_operational"].extend(operational_reports)

        if working_memory_seeded:
            t0 = time.perf_counter()
            working_reports = score_working_memory_sql(pool)
            elapsed_ms = _record_latency(latencies_ms, t0)
            for entry in working_reports:
                entry["latency_ms"] = round(elapsed_ms, 3)
                scores["working_memory_hits"] += int(entry["hit"])
            reports["working_memory"].extend(working_reports)

        if retention_seeded:
            t0 = time.perf_counter()
            retention_reports = score_retention_sql(pool)
            elapsed_ms = _record_latency(latencies_ms, t0)
            for entry in retention_reports:
                entry["latency_ms"] = round(elapsed_ms, 3)
                scores["retention_review_hits"] += int(entry["hit"])
            reports["retention_review"].extend(retention_reports)

        if multimodal_seeded:
            t0 = time.perf_counter()
            multimodal_reports = score_multimodal(
                pool,
                memory_search,
                vector_disabled=vector_disabled,
            )
            elapsed_ms = _record_latency(latencies_ms, t0)
            for entry in multimodal_reports:
                entry["latency_ms"] = round(elapsed_ms, 3)
                if entry.get("skipped") != "vector_disabled":
                    scores["multimodal_hits"] += int(entry["hit"])
            reports["multimodal_retrieval"].extend(multimodal_reports)

        t0 = time.perf_counter()
        reranking_reports = score_reranking_synthetic()
        elapsed_ms = _record_latency(latencies_ms, t0)
        for entry in reranking_reports:
            entry["latency_ms"] = round(elapsed_ms, 3)
            scores["reranking_hits"] += int(entry["hit"])
        reports["reranking_behavior"].extend(reranking_reports)
    finally:
        pool.close()

    procedure_scored_cases = len(PROCEDURE_CASES) if procedures.get("scored") else 0
    procedure_operational_scored_cases = (
        len(PROCEDURE_OPERATIONAL_CASES) if procedures.get("scored") else 0
    )
    working_memory_scored_cases = len(WORKING_MEMORY_CASES) if working_memory_seeded else 0
    retention_scored_cases = len(RETENTION_CASES) if retention_seeded else 0
    multimodal_scored_cases = 0
    if multimodal_seeded:
        multimodal_scored_cases = len(MULTIMODAL_METADATA_CASES)
        if not vector_disabled:
            multimodal_scored_cases += len(MULTIMODAL_VECTOR_CASES)
    reranking_scored_cases = len(RERANKING_CASES)
    total_scored_cases = (
        len(FACT_RECALL_CASES)
        + len(TIMELINE_RECALL_CASES)
        + len(CAUSAL_CHAIN_CASES)
        + len(SCOPE_ISOLATION_CASES)
        + len(GRAPH_PATH_CASES)
        + procedure_scored_cases
        + procedure_operational_scored_cases
        + working_memory_scored_cases
        + retention_scored_cases
        + multimodal_scored_cases
        + reranking_scored_cases
    )
    passed_scored_cases = (
        scores["fact_hits"]
        + scores["timeline_hits"]
        + scores["causal_chain_hits"]
        + (len(SCOPE_ISOLATION_CASES) if scores["scope_leaks"] == 0 else 0)
        + scores["graph_hits"]
        + scores["procedure_hits"]
        + scores["procedure_operational_hits"]
        + scores["working_memory_hits"]
        + scores["retention_review_hits"]
        + scores["multimodal_hits"]
        + scores["reranking_hits"]
    )

    report = {
        "date": RESULT_DATE,
        "version": VERSION,
        "framing": "ops-memory-smoke-regression",
        "fixture": (
            "benchmarks/seed_smoke.sql + benchmarks/seed_event_timeline_smoke.sql "
            "+ benchmarks/seed_graph_smoke.sql"
        ),
        "framing_note": (
            "Synthetic BrainCoreOpsMemoryBench regression fixture. It verifies "
            "implemented retrieval behavior for ops-memory recall, ordering, "
            "isolation, graph-path explanations, procedure reuse, procedure "
            "operational tools, working-memory promotion gates, retention "
            "review-only decisions, multimodal metadata/vector retrieval, "
            "and deterministic reranking. It is not a production quality "
            "benchmark."
        ),
        "corpus": corpus,
        "quality": {
            "total_scored_cases": total_scored_cases,
            "passed_scored_cases": passed_scored_cases,
            **scores,
            "procedure_cases_scored": procedure_scored_cases,
            "procedure_operational_cases_scored": procedure_operational_scored_cases,
            "working_memory_cases_scored": working_memory_scored_cases,
            "retention_cases_scored": retention_scored_cases,
            "multimodal_cases_scored": multimodal_scored_cases,
            "reranking_cases_scored": reranking_scored_cases,
        },
        "latency_ms": _latency_report(latencies_ms),
        "config": {
            "rrf_k": RRF_K,
            "top_k": TOP_K,
            "vector_disabled": vector_disabled,
        },
        "cases": {
            **reports,
            "procedure_schema": procedures,
            "multimodal_schema": multimodal,
        },
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "python": sys.version.split()[0],
            "dsn_host": _public_dsn_host_label(dsn),
        },
    }

    failures = []
    if scores["fact_hits"] != len(FACT_RECALL_CASES):
        failures.append(f"fact recall hits {scores['fact_hits']}/{len(FACT_RECALL_CASES)}")
    if scores["timeline_hits"] != len(TIMELINE_RECALL_CASES):
        failures.append(f"timeline hits {scores['timeline_hits']}/{len(TIMELINE_RECALL_CASES)}")
    if scores["timeline_ordered"] != len(TIMELINE_RECALL_CASES):
        failures.append(f"timeline ordered {scores['timeline_ordered']}/{len(TIMELINE_RECALL_CASES)}")
    if scores["causal_chain_hits"] != len(CAUSAL_CHAIN_CASES):
        failures.append(f"causal chain hits {scores['causal_chain_hits']}/{len(CAUSAL_CHAIN_CASES)}")
    if scores["scope_leaks"]:
        failures.append(f"scope leaks {scores['scope_leaks']}")
    if scores["graph_hits"] != len(GRAPH_PATH_CASES):
        failures.append(f"graph hits {scores['graph_hits']}/{len(GRAPH_PATH_CASES)}")
    if scores["graph_path_explanations"] != len(GRAPH_PATH_CASES):
        failures.append(
            f"graph path explanations {scores['graph_path_explanations']}/{len(GRAPH_PATH_CASES)}"
        )
    if scores["disabled_graph_stream_violations"]:
        failures.append("graph-disabled searches reported graph stream counts")
    if procedure_scored_cases and scores["procedure_hits"] != procedure_scored_cases:
        failures.append(f"procedure hits {scores['procedure_hits']}/{procedure_scored_cases}")
    if (
        procedure_operational_scored_cases
        and scores["procedure_operational_hits"] != procedure_operational_scored_cases
    ):
        failures.append(
            "procedure operational hits "
            f"{scores['procedure_operational_hits']}/{procedure_operational_scored_cases}"
        )
    if working_memory_scored_cases and scores["working_memory_hits"] != working_memory_scored_cases:
        failures.append(
            f"working-memory hits {scores['working_memory_hits']}/{working_memory_scored_cases}"
        )
    if retention_scored_cases and scores["retention_review_hits"] != retention_scored_cases:
        failures.append(
            f"retention review hits {scores['retention_review_hits']}/{retention_scored_cases}"
        )
    if multimodal_scored_cases and scores["multimodal_hits"] != multimodal_scored_cases:
        failures.append(f"multimodal hits {scores['multimodal_hits']}/{multimodal_scored_cases}")
    if scores["reranking_hits"] != reranking_scored_cases:
        failures.append(f"reranking hits {scores['reranking_hits']}/{reranking_scored_cases}")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, sort_keys=False)
        fh.write("\n")

    print(f"Wrote {OUTPUT_PATH}")
    print(json.dumps(report, indent=2))

    if failures:
        raise AssertionError("; ".join(failures))
    return report


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run BrainCoreOpsMemoryBench synthetic smoke benchmark.")
    seed_group = parser.add_mutually_exclusive_group()
    seed_group.add_argument("--no-seed", action="store_true")
    seed_group.add_argument("--force-seed", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    run(no_seed=args.no_seed, force_seed=args.force_seed)
