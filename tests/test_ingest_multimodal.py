"""Focused tests for multimodal metadata ingest helpers."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ingest-multimodal.py"


def load_module():
    os.environ.setdefault("BRAINCORE_POSTGRES_DSN", "test-dsn")
    spec = importlib.util.spec_from_file_location("ingest_multimodal", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["ingest_multimodal"] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeCursor:
    def __init__(self):
        self.executions = []
        self.fetchone_rows = [
            {"media_artifact_id": "11111111-1111-1111-1111-111111111111"},
            {"regions": 2, "media": 1},
        ]
        self.fetchall_rows = [
            [{"artifact_id": "00000000-0000-0000-0000-000000000001"}],
            [{"visual_region_id": "region-1"}],
            [{"media_artifact_id": "media-1"}],
        ]

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.executions.append((sql, params))

    def fetchone(self):
        return self.fetchone_rows.pop(0)

    def fetchall(self):
        return self.fetchall_rows.pop(0)


class FakeConnection:
    def __init__(self):
        self.cur = FakeCursor()
        self.commits = 0

    def cursor(self, row_factory=None):  # noqa: ARG002
        return self.cur

    def commit(self):
        self.commits += 1


def sample_manifest_row():
    return {
        "artifact_id": "00000000-0000-0000-0000-000000000001",
        "media_type": "screenshot",
        "mime_type": "image/png",
        "sha256": "a" * 64,
        "scope_path": "device:alpha",
        "caption": "Login screen",
        "regions": [
            {
                "region_type": "text_block",
                "bbox": [0.1, 0.2, 0.8, 0.4],
                "label": "Error banner",
                "ocr_text": "xrdp session error",
                "linked_fact_id": "ffffffff-0000-0000-0000-000000000001",
                "confidence": 0.92,
            }
        ],
    }


def test_manifest_loader_requires_artifact_and_media_type():
    module = load_module()
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "manifest.jsonl"
        path.write_text(json.dumps({"artifact_id": "id"}) + "\n", encoding="utf-8")

        try:
            module.load_manifest(path)
        except module.MultimodalIngestError as exc:
            assert "media_type is required" in str(exc)
        else:
            raise AssertionError("expected manifest validation failure")


def test_dry_run_counts_media_and_regions_without_writes():
    module = load_module()
    conn = FakeConnection()

    result = module.ingest_manifest(
        conn,
        [sample_manifest_row()],
        ingest_run_id="22222222-2222-2222-2222-222222222222",
        batch_key="batch-1",
        tenant="test-tenant",
        dry_run=True,
        limit=10,
    )

    assert result == {
        "proposed_media": 1,
        "proposed_regions": 1,
        "inserted_media": 0,
        "inserted_regions": 0,
    }
    assert "FROM preserve.artifact" in conn.cur.executions[0][0]
    assert conn.commits == 0


def test_ingest_manifest_upserts_media_and_regions_with_batch_anchors():
    module = load_module()
    conn = FakeConnection()

    result = module.ingest_manifest(
        conn,
        [sample_manifest_row()],
        ingest_run_id="22222222-2222-2222-2222-222222222222",
        batch_key="batch-1",
        tenant="test-tenant",
        dry_run=False,
        limit=10,
    )

    assert result["inserted_media"] == 1
    assert result["inserted_regions"] == 1
    assert conn.commits == 1
    assert "FROM preserve.artifact" in conn.cur.executions[0][0]
    media_sql, media_params = conn.cur.executions[1]
    region_sql, region_params = conn.cur.executions[2]
    assert "INSERT INTO preserve.media_artifact" in media_sql
    assert "ingest_run_id" in media_sql
    assert "ON CONFLICT (tenant, artifact_id) DO UPDATE" in media_sql
    assert media_params[-2:] == ("22222222-2222-2222-2222-222222222222", "batch-1")
    assert "INSERT INTO preserve.visual_region" in region_sql
    assert "ON CONFLICT (tenant, region_fingerprint) DO UPDATE" in region_sql
    assert region_params[-2:] == ("22222222-2222-2222-2222-222222222222", "batch-1")


def test_region_fingerprint_changes_with_text():
    module = load_module()
    row = sample_manifest_row()
    first = module.region_fingerprint("tenant", "media-id", row["regions"][0])
    row["regions"][0]["ocr_text"] = "different text"
    second = module.region_fingerprint("tenant", "media-id", row["regions"][0])

    assert first != second
    assert len(first) == 64


def test_ingest_manifest_rejects_missing_artifact_for_tenant():
    module = load_module()
    conn = FakeConnection()
    conn.cur.fetchall_rows = [[]]

    try:
        module.ingest_manifest(
            conn,
            [sample_manifest_row()],
            ingest_run_id="22222222-2222-2222-2222-222222222222",
            batch_key="batch-1",
            tenant="test-tenant",
            dry_run=True,
            limit=10,
        )
    except module.MultimodalIngestError as exc:
        assert "absent for tenant test-tenant" in str(exc)
    else:
        raise AssertionError("expected missing artifact validation failure")
    assert conn.commits == 0


def test_rollback_uses_ingest_run_id_and_limit():
    module = load_module()
    conn = FakeConnection()
    conn.cur.fetchone_rows = [{"regions": 2, "media": 1}]
    conn.cur.fetchall_rows = [
        [{"visual_region_id": "region-1"}],
        [{"media_artifact_id": "media-1"}],
    ]

    result = module.rollback_ingest(
        conn,
        ingest_run_id="22222222-2222-2222-2222-222222222222",
        tenant="test-tenant",
        limit=5,
        dry_run=False,
    )

    assert result == {
        "proposed_media": 1,
        "proposed_regions": 2,
        "deleted_media": 1,
        "deleted_regions": 1,
    }
    assert conn.commits == 1
    assert "FROM preserve.visual_region" in conn.cur.executions[1][0]
    assert "LIMIT %s" in conn.cur.executions[1][0]
    assert conn.cur.executions[1][1] == (
        "test-tenant",
        "22222222-2222-2222-2222-222222222222",
        5,
    )
