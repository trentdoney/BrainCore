"""Verify migrations run clean and produce the expected schema.

Consumes BRAINCORE_TEST_DSN env var. Does NOT spin up Docker itself
(that is the CI workflow's responsibility, not the test's).
"""

import os
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest
from psycopg import sql

DSN = os.environ["BRAINCORE_TEST_DSN"]  # fail-fast if unset
ROOT = Path(__file__).resolve().parents[1]
SQL_DIR = ROOT / "sql"
PRE_REPAIR_MIGRATIONS = [
    "001_preserve_schema.sql",
    "003_seed_entities.sql",
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
        "vault_incident",
        "personal_memory",
        "project_doc",
        "telegram_chat",
        "asana_task",
        "git_commit",
    }
    assert required.issubset(values), f"missing: {required - values}"


def test_eval_run_table_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM preserve.eval_run LIMIT 0")  # raises if missing


def test_forty_five_preserve_tables_exist():
    # Fresh installs now get the full 45-table preserve schema directly
    # from the base schema, eval migrations, tenant-isolation migration,
    # memory graph migration, and runtime migration ledger bootstrap.
    # Example project seeds remain opt-in and are no longer part of the
    # default migration path.
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM pg_tables WHERE schemaname='preserve'")
        count = cur.fetchone()[0]
    assert count == 45, f"expected 45 preserve tables, found {count}"


def test_project_service_map_table_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM preserve.project_service_map LIMIT 0"
        )


def test_enterprise_lifecycle_schema_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'preserve'
              AND table_name IN (
                'lifecycle_outbox',
                'lifecycle_target_intelligence',
                'lifecycle_cue',
                'context_recall_audit',
                'lifecycle_feedback_event',
                'lifecycle_score_audit',
                'lifecycle_audit_log'
              )
            """
        )
        tables = {row[0] for row in cur.fetchall()}

        cur.execute(
            """
            SELECT conname
            FROM pg_constraint
            WHERE connamespace = 'preserve'::regnamespace
              AND conname IN (
                'uq_lifecycle_outbox_tenant_idempotency',
                'uq_lifecycle_intelligence_target',
                'uq_lifecycle_cue_target_hash'
              )
            """
        )
        constraints = {row[0] for row in cur.fetchall()}

        cur.execute(
            """
            SELECT tgname
            FROM pg_trigger
            WHERE tgname IN (
                'trg_lifecycle_feedback_append_only',
                'trg_lifecycle_score_audit_append_only',
                'trg_lifecycle_audit_log_append_only'
            )
            """
        )
        triggers = {row[0] for row in cur.fetchall()}

    assert tables == {
        "lifecycle_outbox",
        "lifecycle_target_intelligence",
        "lifecycle_cue",
        "context_recall_audit",
        "lifecycle_feedback_event",
        "lifecycle_score_audit",
        "lifecycle_audit_log",
    }
    assert constraints == {
        "uq_lifecycle_outbox_tenant_idempotency",
        "uq_lifecycle_intelligence_target",
        "uq_lifecycle_cue_target_hash",
    }
    assert triggers == {
        "trg_lifecycle_feedback_append_only",
        "trg_lifecycle_score_audit_append_only",
        "trg_lifecycle_audit_log_append_only",
    }


def test_eval_case_table_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM preserve.eval_case LIMIT 0")


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


def test_memory_graph_schema_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'preserve'
              AND table_name IN (
                'memory_edge',
                'memory_edge_evidence',
                'memory_revision',
                'memory_revision_support'
              )
            """
        )
        tables = {row[0] for row in cur.fetchall()}

        cur.execute(
            """
            SELECT table_name, column_name, column_default, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'preserve'
              AND table_name IN ('memory_edge', 'memory_revision')
              AND column_name = 'tenant'
            ORDER BY table_name
            """
        )
        tenant_columns = cur.fetchall()

        cur.execute(
            """
            SELECT conname
            FROM pg_constraint
            WHERE connamespace = 'preserve'::regnamespace
              AND conname IN (
                'uq_memory_edge_tenant_fingerprint',
                'chk_memory_edge_type',
                'chk_memory_edge_source_type',
                'chk_memory_edge_target_type',
                'chk_memory_revision_type'
              )
            """
        )
        constraints = {row[0] for row in cur.fetchall()}

    assert tables == {
        "memory_edge",
        "memory_edge_evidence",
        "memory_revision",
        "memory_revision_support",
    }
    assert tenant_columns == [
        ("memory_edge", "tenant", None, "NO"),
        ("memory_revision", "tenant", None, "NO"),
    ]
    assert constraints == {
        "uq_memory_edge_tenant_fingerprint",
        "chk_memory_edge_type",
        "chk_memory_edge_source_type",
        "chk_memory_edge_target_type",
        "chk_memory_revision_type",
    }


def test_event_frame_schema_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, column_default, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'preserve'
              AND table_name = 'event_frame'
              AND column_name IN ('tenant', 'source_fact_id', 'evidence_segment_id')
            ORDER BY column_name
            """
        )
        columns = cur.fetchall()

        cur.execute(
            """
            SELECT conname
            FROM pg_constraint
            WHERE connamespace = 'preserve'::regnamespace
              AND conname IN (
                'uq_event_frame_tenant_fingerprint',
                'chk_event_frame_time_range'
              )
            """
        )
        constraints = {row[0] for row in cur.fetchall()}

    assert columns == [
        ("evidence_segment_id", None, "YES"),
        ("source_fact_id", None, "YES"),
        ("tenant", None, "NO"),
    ]
    assert constraints == {
        "uq_event_frame_tenant_fingerprint",
        "chk_event_frame_time_range",
    }


def test_procedure_memory_schema_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'preserve'
              AND table_name IN ('procedure', 'procedure_step')
            """
        )
        tables = {row[0] for row in cur.fetchall()}

        cur.execute(
            """
            SELECT table_name, column_name, column_default, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'preserve'
              AND table_name IN ('procedure', 'procedure_step')
              AND column_name IN ('tenant', 'source_fact_id', 'evidence_segment_id', 'scope_path')
            ORDER BY table_name, column_name
            """
        )
        columns = cur.fetchall()

        cur.execute(
            """
            SELECT conname
            FROM pg_constraint
            WHERE connamespace = 'preserve'::regnamespace
              AND conname IN (
                'uq_procedure_tenant_fingerprint',
                'uq_procedure_tenant_id',
                'fk_procedure_step_tenant_procedure',
                'chk_procedure_has_evidence',
                'uq_procedure_step_order',
                'chk_procedure_step_has_evidence'
              )
            """
        )
        constraints = {row[0] for row in cur.fetchall()}

    assert tables == {"procedure", "procedure_step"}
    assert columns == [
        ("procedure", "evidence_segment_id", None, "YES"),
        ("procedure", "scope_path", None, "YES"),
        ("procedure", "source_fact_id", None, "YES"),
        ("procedure", "tenant", None, "NO"),
        ("procedure_step", "evidence_segment_id", None, "YES"),
        ("procedure_step", "scope_path", None, "YES"),
        ("procedure_step", "source_fact_id", None, "YES"),
        ("procedure_step", "tenant", None, "NO"),
    ]
    assert constraints == {
        "uq_procedure_tenant_fingerprint",
        "uq_procedure_tenant_id",
        "fk_procedure_step_tenant_procedure",
        "chk_procedure_has_evidence",
        "uq_procedure_step_order",
        "chk_procedure_step_has_evidence",
    }


def test_reflection_health_schema_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'preserve'
              AND table_name IN (
                'reflection_class',
                'entity_summary',
                'entity_summary_evidence',
                'belief',
                'belief_evidence',
                'rule',
                'rule_evidence',
                'memory_usage',
                'memory_health',
                'memory_health_evidence'
              )
            """
        )
        tables = {row[0] for row in cur.fetchall()}

        cur.execute(
            """
            SELECT table_name, column_name, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'preserve'
              AND table_name IN ('entity_summary', 'belief', 'rule', 'memory_health')
              AND column_name IN ('primary_evidence_segment_id', 'usage_id')
            ORDER BY table_name, column_name
            """
        )
        evidence_columns = cur.fetchall()

        cur.execute(
            """
            SELECT conname
            FROM pg_constraint
            WHERE connamespace = 'preserve'::regnamespace
              AND conname IN (
                'uq_entity_summary_tenant_fingerprint',
                'chk_entity_summary_evidence_has_source',
                'uq_belief_tenant_fingerprint',
                'chk_belief_not_deterministic_fact',
                'chk_belief_evidence_has_source',
                'uq_rule_tenant_fingerprint',
                'chk_rule_evidence_has_source',
                'uq_memory_usage_tenant_fingerprint',
                'uq_memory_health_tenant_fingerprint',
                'chk_memory_health_evidence_has_source'
              )
            """
        )
        constraints = {row[0] for row in cur.fetchall()}

    assert tables == {
        "reflection_class",
        "entity_summary",
        "entity_summary_evidence",
        "belief",
        "belief_evidence",
        "rule",
        "rule_evidence",
        "memory_usage",
        "memory_health",
        "memory_health_evidence",
    }
    assert evidence_columns == [
        ("belief", "primary_evidence_segment_id", "NO"),
        ("entity_summary", "primary_evidence_segment_id", "NO"),
        ("memory_health", "usage_id", "NO"),
        ("rule", "primary_evidence_segment_id", "NO"),
    ]
    assert constraints == {
        "uq_entity_summary_tenant_fingerprint",
        "chk_entity_summary_evidence_has_source",
        "uq_belief_tenant_fingerprint",
        "chk_belief_not_deterministic_fact",
        "chk_belief_evidence_has_source",
        "uq_rule_tenant_fingerprint",
        "chk_rule_evidence_has_source",
        "uq_memory_usage_tenant_fingerprint",
        "uq_memory_health_tenant_fingerprint",
        "chk_memory_health_evidence_has_source",
    }


def test_active_agent_session_schema_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'preserve'
              AND table_name IN ('task_session', 'working_memory')
            """
        )
        tables = {row[0] for row in cur.fetchall()}

        cur.execute(
            """
            SELECT table_name, column_name, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'preserve'
              AND table_name IN ('task_session', 'working_memory')
              AND column_name IN (
                'tenant',
                'expires_at',
                'promotion_status',
                'promotion_target_id',
                'promotion_target_kind',
                'promoted_memory_id',
                'evidence_segment_id'
              )
            ORDER BY table_name, column_name
            """
        )
        columns = cur.fetchall()

        cur.execute(
            """
            SELECT conname
            FROM pg_constraint
            WHERE connamespace = 'preserve'::regnamespace
              AND conname IN (
                'uq_task_session_tenant_key',
                'uq_task_session_tenant_id',
                'fk_working_memory_tenant_session',
                'uq_working_memory_tenant_fingerprint',
                'chk_working_memory_promotion_has_evidence',
                'chk_working_memory_promotion_target_kind',
                'chk_working_memory_promotion_target_pair',
                'chk_working_memory_promoted_target'
              )
            """
        )
        constraints = {row[0] for row in cur.fetchall()}

    assert tables == {"task_session", "working_memory"}
    assert columns == [
        ("task_session", "expires_at", "YES"),
        ("task_session", "tenant", "NO"),
        ("working_memory", "evidence_segment_id", "YES"),
        ("working_memory", "expires_at", "NO"),
        ("working_memory", "promoted_memory_id", "YES"),
        ("working_memory", "promotion_status", "NO"),
        ("working_memory", "promotion_target_id", "YES"),
        ("working_memory", "promotion_target_kind", "YES"),
        ("working_memory", "tenant", "NO"),
    ]
    assert constraints == {
        "uq_task_session_tenant_key",
        "uq_task_session_tenant_id",
        "fk_working_memory_tenant_session",
        "uq_working_memory_tenant_fingerprint",
        "chk_working_memory_promotion_has_evidence",
        "chk_working_memory_promotion_target_kind",
        "chk_working_memory_promotion_target_pair",
        "chk_working_memory_promoted_target",
    }


def test_working_memory_promotion_requires_evidence_boundary():
    session_key = f"session-{uuid.uuid4().hex[:12]}"
    fingerprint = f"wm-{uuid.uuid4().hex[:12]}"
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        session_ids = {}
        for tenant in ("tenant_a", "tenant_b"):
            cur.execute(
                """
                INSERT INTO preserve.task_session (
                    tenant, session_key, agent_name, task_title
                ) VALUES (
                    %s, %s, 'codex', 'migration behavior test'
                )
                RETURNING session_id
                """,
                (tenant, session_key),
            )
            session_ids[tenant] = cur.fetchone()[0]

        assert session_ids["tenant_a"] != session_ids["tenant_b"]

        cur.execute(
            """
            INSERT INTO preserve.working_memory (
                tenant,
                session_id,
                working_memory_fingerprint,
                memory_kind,
                content,
                expires_at
            ) VALUES (
                'tenant_a', %s, %s, 'context', 'ephemeral note', now() + interval '1 hour'
            )
            RETURNING working_memory_id
            """,
            (session_ids["tenant_a"], fingerprint),
        )
        assert cur.fetchone()[0] is not None

        with pytest.raises(psycopg.errors.CheckViolation):
            cur.execute(
                """
                INSERT INTO preserve.working_memory (
                    tenant,
                    session_id,
                    working_memory_fingerprint,
                    memory_kind,
                    content,
                    promotion_status,
                    expires_at
                ) VALUES (
                    'tenant_a', %s, %s, 'decision', 'candidate without evidence',
                    'promotion_candidate', now() + interval '1 hour'
                )
                """,
                (session_ids["tenant_a"], f"{fingerprint}-candidate"),
            )
        conn.rollback()


def test_working_memory_promotion_target_pair_is_validated():
    session_key = f"session-{uuid.uuid4().hex[:12]}"
    fingerprint = f"wm-{uuid.uuid4().hex[:12]}"
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO preserve.task_session (
                tenant, session_key, agent_name, task_title
            ) VALUES (
                'tenant_a', %s, 'codex', 'migration target test'
            )
            RETURNING session_id
            """,
            (session_key,),
        )
        session_id = cur.fetchone()[0]

        with pytest.raises(psycopg.errors.CheckViolation):
            cur.execute(
                """
                INSERT INTO preserve.working_memory (
                    tenant,
                    session_id,
                    working_memory_fingerprint,
                    memory_kind,
                    content,
                    source_fact_id,
                    promotion_status,
                    promotion_target_kind,
                    expires_at
                ) VALUES (
                    'tenant_a', %s, %s, 'decision', 'candidate target missing id',
                    gen_random_uuid(), 'promotion_candidate', 'fact', now() + interval '1 hour'
                )
                """,
                (session_id, fingerprint),
            )
        conn.rollback()


def test_multimodal_layout_schema_exists():
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'preserve'
              AND table_name IN (
                'embedding_index',
                'media_artifact',
                'visual_region'
              )
            """
        )
        tables = {row[0] for row in cur.fetchall()}

        cur.execute(
            """
            SELECT table_name, column_name, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'preserve'
              AND table_name IN ('embedding_index', 'media_artifact', 'visual_region')
              AND column_name IN (
                'tenant',
                'artifact_id',
                'media_artifact_id',
                'visual_region_id',
                'source_segment_id',
                'ingest_run_id',
                'ingest_batch_key',
                'embedding',
                'embedding_dimension'
              )
            ORDER BY table_name, column_name
            """
        )
        columns = cur.fetchall()

        cur.execute(
            """
            SELECT conname
            FROM pg_constraint
            WHERE connamespace = 'preserve'::regnamespace
              AND conname IN (
                'uq_media_artifact_tenant_artifact',
                'uq_media_artifact_tenant_id',
                'chk_media_artifact_type',
                'uq_visual_region_tenant_fingerprint',
                'uq_visual_region_tenant_id',
                'fk_visual_region_tenant_media',
                'chk_visual_region_bbox_order',
                'chk_visual_region_normalized_bounds',
                'uq_embedding_index_tenant_fingerprint',
                'fk_embedding_index_tenant_media',
                'fk_embedding_index_tenant_region',
                'chk_embedding_index_one_target',
                'chk_embedding_index_target_matches_kind',
                'chk_embedding_index_dimension'
              )
            """
        )
        constraints = {row[0] for row in cur.fetchall()}

        cur.execute(
            """
            SELECT indexname
            FROM pg_indexes
            WHERE schemaname = 'preserve'
              AND tablename = 'embedding_index'
              AND indexname = 'idx_embedding_index_vector'
            """
        )
        vector_indexes = {row[0] for row in cur.fetchall()}

        cur.execute(
            """
            SELECT pg_get_constraintdef(oid)
            FROM pg_constraint
            WHERE connamespace = 'preserve'::regnamespace
              AND conrelid = 'preserve.embedding_index'::regclass
              AND conname = 'chk_embedding_index_vector_role'
            """
        )
        vector_role_constraint = cur.fetchone()[0]

    assert tables == {
        "embedding_index",
        "media_artifact",
        "visual_region",
    }
    assert columns == [
        ("embedding_index", "artifact_id", "YES"),
        ("embedding_index", "embedding", "NO"),
        ("embedding_index", "embedding_dimension", "NO"),
        ("embedding_index", "media_artifact_id", "YES"),
        ("embedding_index", "source_segment_id", "YES"),
        ("embedding_index", "tenant", "NO"),
        ("embedding_index", "visual_region_id", "YES"),
        ("media_artifact", "artifact_id", "NO"),
        ("media_artifact", "ingest_batch_key", "YES"),
        ("media_artifact", "ingest_run_id", "YES"),
        ("media_artifact", "media_artifact_id", "NO"),
        ("media_artifact", "source_segment_id", "YES"),
        ("media_artifact", "tenant", "NO"),
        ("visual_region", "ingest_batch_key", "YES"),
        ("visual_region", "ingest_run_id", "YES"),
        ("visual_region", "media_artifact_id", "NO"),
        ("visual_region", "source_segment_id", "YES"),
        ("visual_region", "tenant", "NO"),
        ("visual_region", "visual_region_id", "NO"),
    ]
    assert constraints == {
        "uq_media_artifact_tenant_artifact",
        "uq_media_artifact_tenant_id",
        "chk_media_artifact_type",
        "uq_visual_region_tenant_fingerprint",
        "uq_visual_region_tenant_id",
        "fk_visual_region_tenant_media",
        "chk_visual_region_bbox_order",
        "chk_visual_region_normalized_bounds",
        "uq_embedding_index_tenant_fingerprint",
        "fk_embedding_index_tenant_media",
        "fk_embedding_index_tenant_region",
        "chk_embedding_index_one_target",
        "chk_embedding_index_target_matches_kind",
        "chk_embedding_index_dimension",
    }
    for role in {
        "text",
        "evidence",
        "procedure",
        "media_caption",
        "visual_ocr",
        "visual_caption",
    }:
        assert role in vector_role_constraint
    assert vector_indexes == {"idx_embedding_index_vector"}

    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT indexname
            FROM pg_indexes
            WHERE schemaname = 'preserve'
              AND indexname IN (
                'idx_media_artifact_ingest_run',
                'idx_media_artifact_ingest_batch',
                'idx_visual_region_ingest_run',
                'idx_visual_region_ingest_batch'
              )
            """
        )
        ingest_indexes = {row[0] for row in cur.fetchall()}

    assert ingest_indexes == {
        "idx_media_artifact_ingest_run",
        "idx_media_artifact_ingest_batch",
        "idx_visual_region_ingest_run",
        "idx_visual_region_ingest_batch",
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
                %s, %s, 'vault_incident', %s, %s, 1
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
                %s, %s, 'vault_incident', %s, %s, 1
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
                        %s, %s, 'vault_incident', %s, %s, 1
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
