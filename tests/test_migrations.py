"""Verify migrations 001-008 run clean and produce the expected schema.

Consumes BRAINCORE_TEST_DSN env var. Does NOT spin up Docker itself
(that is the CI workflow's responsibility, not the test's).
"""

import os

import psycopg

DSN = os.environ["BRAINCORE_TEST_DSN"]  # fail-fast if unset


def test_source_type_enum_has_all_values():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT unnest(enum_range(NULL::preserve.source_type)) ORDER BY 1"
        )
        values = {row[0] for row in cur.fetchall()}
    required = {
        "claude_plan",
        "claude_session",
        "codex_session",
        "codex_shared",
        "config_diff",
        "device_log",
        "discord_conversation",
        "monitoring_alert",
        "opsvault_incident",
        "pai_memory",
        "project_doc",
        "telegram_chat",
    }
    assert required.issubset(values), f"missing: {required - values}"


def test_eval_run_table_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM preserve.eval_run LIMIT 0")  # raises if missing


def test_fourteen_preserve_tables_exist():
    # Phase 0 reached 13 preserve tables (001 baseline 11 + patched 004
    # project_service_map + 007 eval_run). Phase 3 adds migration 008
    # (eval_case) which closes BL-12 and brings the running total to 14.
    # Stream A's original 13-table assertion (renamed from
    # test_thirteen_preserve_tables_exist) is now historical — every fresh
    # install runs 001-008 and ends up with 14 preserve tables.
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM pg_tables WHERE schemaname='preserve'")
        count = cur.fetchone()[0]
    assert count == 14, f"expected 14 preserve tables, found {count}"


def test_project_service_map_table_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM preserve.project_service_map LIMIT 0"
        )  # BL-10


def test_eval_case_table_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM preserve.eval_case LIMIT 0")  # BL-12 closure
