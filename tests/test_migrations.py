"""Verify migrations 001-010 run clean and produce the expected schema.

Consumes BRAINCORE_TEST_DSN env var. Does NOT spin up Docker itself
(that is the CI workflow's responsibility, not the test's).
"""

import os
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
from psycopg import sql

DSN = os.environ["BRAINCORE_TEST_DSN"]  # fail-fast if unset
ROOT = Path(__file__).resolve().parents[1]
SQL_DIR = ROOT / "sql"
PRE_REPAIR_MIGRATIONS = [
    "001_preserve_schema.sql",
    "003_seed_entities.sql",
    "004_seed_projects.example.sql",
    "005_priority_tenant.sql",
    "006_source_type_values.sql",
    "007_eval_run.sql",
    "008_eval_case.sql",
    "009_schema_alignment.sql",
]


def _admin_dsn(dsn: str) -> str:
    parts = urlsplit(dsn)
    return urlunsplit((parts.scheme, parts.netloc, "/postgres", parts.query, parts.fragment))


def _create_temp_database(prefix: str) -> tuple[str, str]:
    db_name = f"{prefix}_{uuid.uuid4().hex[:8]}"
    admin_dsn = _admin_dsn(DSN)
    with psycopg.connect(admin_dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(db_name)))
    parts = urlsplit(DSN)
    temp_dsn = urlunsplit((parts.scheme, parts.netloc, f"/{db_name}", parts.query, parts.fragment))
    return db_name, temp_dsn


def _drop_temp_database(db_name: str) -> None:
    admin_dsn = _admin_dsn(DSN)
    with psycopg.connect(admin_dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = %s
              AND pid <> pg_backend_pid()
            """,
            (db_name,),
        )
        cur.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(db_name)))


def _apply_pre_repair_migrations(dsn: str) -> None:
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("CREATE SCHEMA IF NOT EXISTS preserve")
        cur.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
        for name in PRE_REPAIR_MIGRATIONS:
            cur.execute((SQL_DIR / name).read_text())


def _apply_repair_migration(dsn: str) -> None:
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute((SQL_DIR / "010_tenant_isolation.sql").read_text())


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


def test_schema_alignment_columns_exist():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'preserve'
              AND (
                (table_name IN ('artifact', 'fact', 'segment', 'episode', 'memory')
                 AND column_name = 'project_entity_id')
                OR (table_name = 'fact' AND column_name = 'importance_score')
                OR (table_name = 'memory' AND column_name = 'last_supported_at')
              )
            ORDER BY table_name, column_name
            """
        )
        rows = {(table, column) for table, column in cur.fetchall()}

    expected = {
        ("artifact", "project_entity_id"),
        ("fact", "project_entity_id"),
        ("fact", "importance_score"),
        ("segment", "project_entity_id"),
        ("episode", "project_entity_id"),
        ("memory", "project_entity_id"),
        ("memory", "last_supported_at"),
    }
    assert expected.issubset(rows), f"missing: {expected - rows}"


def test_tenant_scoped_uniques_exist():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT conname
            FROM pg_constraint
            WHERE connamespace = 'preserve'::regnamespace
              AND conname IN (
                'uq_artifact_tenant_source_key',
                'uq_entity_tenant_type_name',
                'uq_memory_tenant_fingerprint'
              )
            """
        )
        constraints = {row[0] for row in cur.fetchall()}

    assert constraints == {
        "uq_artifact_tenant_source_key",
        "uq_entity_tenant_type_name",
        "uq_memory_tenant_fingerprint",
    }


def test_entity_upsert_is_tenant_scoped():
    name = f"tenant-scope-{uuid.uuid4().hex[:12]}"
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO preserve.entity (tenant, canonical_name, entity_type)
            VALUES (%s, %s, 'service')
            ON CONFLICT (tenant, entity_type, canonical_name) DO UPDATE
              SET last_seen_at = now()
            RETURNING entity_id
            """,
            ("tenant_a", name),
        )
        first_id = cur.fetchone()[0]

        cur.execute(
            """
            INSERT INTO preserve.entity (tenant, canonical_name, entity_type)
            VALUES (%s, %s, 'service')
            ON CONFLICT (tenant, entity_type, canonical_name) DO UPDATE
              SET last_seen_at = now()
            RETURNING entity_id
            """,
            ("tenant_b", name),
        )
        second_id = cur.fetchone()[0]

    assert first_id != second_id


def test_artifact_source_key_is_tenant_scoped():
    key = f"tenant-artifact:{uuid.uuid4().hex[:12]}"
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO preserve.artifact (
                tenant, source_key, source_type, original_path, sha256, size_bytes
            ) VALUES (
                %s, %s, 'opsvault_incident', %s, %s, 1
            )
            RETURNING artifact_id
            """,
            ("tenant_a", key, f"/tmp/{key}-a", uuid.uuid4().hex),
        )
        first_id = cur.fetchone()[0]

        cur.execute(
            """
            INSERT INTO preserve.artifact (
                tenant, source_key, source_type, original_path, sha256, size_bytes
            ) VALUES (
                %s, %s, 'opsvault_incident', %s, %s, 1
            )
            RETURNING artifact_id
            """,
            ("tenant_b", key, f"/tmp/{key}-b", uuid.uuid4().hex),
        )
        second_id = cur.fetchone()[0]

    assert first_id != second_id


def test_memory_fingerprint_is_tenant_scoped():
    fingerprint = f"tenant-memory-{uuid.uuid4().hex[:12]}"
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO preserve.memory (tenant, fingerprint, title)
            VALUES (%s, %s, %s)
            RETURNING memory_id
            """,
            ("tenant_a", fingerprint, "Tenant A memory"),
        )
        first_id = cur.fetchone()[0]

        cur.execute(
            """
            INSERT INTO preserve.memory (tenant, fingerprint, title)
            VALUES (%s, %s, %s)
            RETURNING memory_id
            """,
            ("tenant_b", fingerprint, "Tenant B memory"),
        )
        second_id = cur.fetchone()[0]

    assert first_id != second_id


def test_tenant_isolation_repair_splits_shared_entity_and_memory():
    db_name, repair_dsn = _create_temp_database("braincore_tenant_repair")
    try:
        _apply_pre_repair_migrations(repair_dsn)

        shared_name = f"repair-entity-{uuid.uuid4().hex[:10]}"
        shared_fingerprint = f"repair-memory-{uuid.uuid4().hex[:10]}"
        with psycopg.connect(repair_dsn) as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO preserve.entity (tenant, canonical_name, entity_type)
                VALUES (%s, %s, 'service')
                RETURNING entity_id
                """,
                ("tenant_a", shared_name),
            )
            shared_entity_id = cur.fetchone()[0]

            artifacts = {}
            runs = {}
            for tenant in ("tenant_a", "tenant_b"):
                source_key = f"{tenant}:repair-artifact:{uuid.uuid4().hex[:10]}"
                cur.execute(
                    """
                    INSERT INTO preserve.artifact (
                        tenant, source_key, source_type, original_path, sha256, size_bytes
                    ) VALUES (
                        %s, %s, 'opsvault_incident', %s, %s, 1
                    )
                    RETURNING artifact_id
                    """,
                    (tenant, source_key, f"/tmp/{source_key}", uuid.uuid4().hex),
                )
                artifacts[tenant] = cur.fetchone()[0]
                cur.execute(
                    """
                    INSERT INTO preserve.extraction_run (
                        artifact_id, pipeline_version, model_name, prompt_version, status,
                        started_at, finished_at
                    ) VALUES (
                        %s, 'tenant-repair-test', 'test-model', 'test-prompt', 'success',
                        now(), now()
                    )
                    RETURNING run_id
                    """,
                    (artifacts[tenant],),
                )
                runs[tenant] = cur.fetchone()[0]

            fact_ids = {}
            for tenant in ("tenant_a", "tenant_b"):
                cur.execute(
                    """
                    INSERT INTO preserve.fact (
                        subject_entity_id, predicate, fact_kind, confidence,
                        canonical_fingerprint, created_run_id, tenant
                    ) VALUES (
                        %s, 'mentions', 'event', 0.90, %s, %s, %s
                    )
                    RETURNING fact_id
                    """,
                    (
                        shared_entity_id,
                        f"{tenant}:{uuid.uuid4().hex[:10]}",
                        runs[tenant],
                        tenant,
                    ),
                )
                fact_ids[tenant] = cur.fetchone()[0]

            cur.execute(
                """
                INSERT INTO preserve.memory (
                    tenant, fingerprint, title, lifecycle_state, support_count
                ) VALUES (
                    'tenant_a', %s, 'Shared repair memory', 'published', 2
                )
                RETURNING memory_id
                """,
                (shared_fingerprint,),
            )
            shared_memory_id = cur.fetchone()[0]

            for tenant in ("tenant_a", "tenant_b"):
                cur.execute(
                    """
                    INSERT INTO preserve.memory_support (memory_id, fact_id, support_type)
                    VALUES (%s, %s, 'supporting')
                    """,
                    (shared_memory_id, fact_ids[tenant]),
                )

            conn.commit()

        _apply_repair_migration(repair_dsn)

        with psycopg.connect(repair_dsn) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT tenant, entity_id
                FROM preserve.entity
                WHERE canonical_name = %s
                  AND entity_type = 'service'
                ORDER BY tenant
                """,
                (shared_name,),
            )
            entity_rows = cur.fetchall()
            assert [row[0] for row in entity_rows] == ["tenant_a", "tenant_b"]
            assert entity_rows[0][1] != entity_rows[1][1]

            cur.execute(
                """
                SELECT f.tenant, e.tenant, f.subject_entity_id
                FROM preserve.fact f
                JOIN preserve.entity e ON e.entity_id = f.subject_entity_id
                WHERE f.fact_id IN (%s, %s)
                ORDER BY f.tenant
                """,
                (fact_ids["tenant_a"], fact_ids["tenant_b"]),
            )
            fact_rows = cur.fetchall()
            assert fact_rows == [
                ("tenant_a", "tenant_a", entity_rows[0][1]),
                ("tenant_b", "tenant_b", entity_rows[1][1]),
            ]

            cur.execute(
                """
                SELECT tenant, memory_id
                FROM preserve.memory
                WHERE fingerprint = %s
                ORDER BY tenant
                """,
                (shared_fingerprint,),
            )
            memory_rows = cur.fetchall()
            assert [row[0] for row in memory_rows] == ["tenant_a", "tenant_b"]
            assert memory_rows[0][1] != memory_rows[1][1]

            cur.execute(
                """
                SELECT m.tenant, f.tenant
                FROM preserve.memory_support ms
                JOIN preserve.memory m ON m.memory_id = ms.memory_id
                JOIN preserve.fact f ON f.fact_id = ms.fact_id
                WHERE f.fact_id IN (%s, %s)
                ORDER BY f.tenant
                """,
                (fact_ids["tenant_a"], fact_ids["tenant_b"]),
            )
            support_rows = cur.fetchall()
            assert support_rows == [("tenant_a", "tenant_a"), ("tenant_b", "tenant_b")]
    finally:
        _drop_temp_database(db_name)
