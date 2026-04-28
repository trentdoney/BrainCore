"""Focused tests for feature-flagged embedding_index retrieval."""

from __future__ import annotations

from datetime import datetime, timezone

import mcp.memory_search as ms


class FakeCursor:
    def __init__(self, responses):
        self.responses = list(responses)
        self.executions = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params):
        self.executions.append((sql, params))

    def fetchall(self):
        return self.responses.pop(0)


class FakeConnection:
    def __init__(self, cursor):
        self.cursor_obj = cursor

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def cursor(self, row_factory=None):  # noqa: ARG002
        return self.cursor_obj


class FakePool:
    def __init__(self, responses):
        self.cursor_obj = FakeCursor(responses)

    def connection(self):
        return FakeConnection(self.cursor_obj)


def test_embedding_index_vector_stream_is_feature_flagged(monkeypatch):
    monkeypatch.setattr(ms, "EMBEDDING_INDEX_RETRIEVAL_ENABLED", True)
    monkeypatch.setattr(ms, "embed_query", lambda _query: [0.25] * 384)
    pool = FakePool([
        [{
            "object_id": "11111111-1111-1111-1111-111111111111",
            "object_type": "fact",
            "title": "remediation",
            "summary": "xrdp recovered",
            "confidence": 0.91,
            "valid_from": datetime(2026, 4, 26, tzinfo=timezone.utc),
            "valid_to": None,
            "scope_path": "device:alpha",
            "priority": 3,
        }],
        [{
            "object_id": "22222222-2222-2222-2222-222222222222",
            "object_type": "segment",
            "title": "Summary",
            "summary": "xrdp service recovery evidence",
            "confidence": None,
            "valid_from": None,
            "valid_to": None,
            "scope_path": "device:alpha",
            "priority": None,
        }],
        [{
            "object_id": "33333333-3333-3333-3333-333333333333",
            "object_type": "procedure",
            "title": "Recover xrdp",
            "summary": "Restart xrdp and verify remote access",
            "confidence": 0.86,
            "valid_from": None,
            "valid_to": None,
            "scope_path": "device:alpha",
            "priority": 4,
        }],
        [{
            "object_id": "44444444-4444-4444-4444-444444444444",
            "object_type": "media_artifact",
            "title": "xrdp status screenshot",
            "summary": "Terminal screenshot showing xrdp active",
            "confidence": None,
            "valid_from": None,
            "valid_to": None,
            "scope_path": "device:alpha",
            "priority": None,
        }],
        [{
            "object_id": "55555555-5555-5555-5555-555555555555",
            "object_type": "visual_region",
            "title": "xrdp status",
            "summary": "Terminal screenshot showing xrdp active",
            "confidence": 0.74,
            "valid_from": None,
            "valid_to": None,
            "scope_path": "device:alpha",
            "priority": None,
        }],
    ])

    results = ms._stream_vector(  # noqa: SLF001
        pool,
        "xrdp recovery",
        as_of="2026-04-26T00:00:00Z",
        scope="device:alpha",
        type_filter=None,
        limit=5,
    )

    assert [result.object_type for result in results] == [
        "fact",
        "segment",
        "procedure",
        "media_artifact",
        "visual_region",
    ]
    fact_sql, fact_params = pool.cursor_obj.executions[0]
    segment_sql, segment_params = pool.cursor_obj.executions[1]
    procedure_sql, procedure_params = pool.cursor_obj.executions[2]
    media_sql, media_params = pool.cursor_obj.executions[3]
    visual_sql, visual_params = pool.cursor_obj.executions[4]
    assert "FROM preserve.embedding_index ei" in fact_sql
    assert "JOIN preserve.fact f" in fact_sql
    assert "ei.vector_role = 'evidence'" in fact_sql
    assert "f.tenant = %s" in fact_sql
    assert fact_params[1] == ms.TENANT
    assert "FROM preserve.embedding_index ei" in segment_sql
    assert "JOIN preserve.segment s" in segment_sql
    assert "ei.vector_role = 'text'" in segment_sql
    assert "s.tenant = %s" in segment_sql
    assert segment_params[1] == ms.TENANT
    assert "FROM preserve.embedding_index ei" in procedure_sql
    assert "JOIN preserve.procedure" in procedure_sql
    assert "ei.target_kind = 'procedure'" in procedure_sql
    assert procedure_params[1] == ms.TENANT
    assert "FROM preserve.embedding_index ei" in media_sql
    assert "JOIN preserve.media_artifact ma" in media_sql
    assert "ei.vector_role = 'media_caption'" in media_sql
    assert "ei.target_kind = 'media_artifact'" in media_sql
    assert media_params[1] == ms.TENANT
    assert "FROM preserve.embedding_index ei" in visual_sql
    assert "JOIN preserve.visual_region vr" in visual_sql
    assert "ei.vector_role IN ('visual_ocr', 'visual_caption')" in visual_sql
    assert "ei.target_kind = 'visual_region'" in visual_sql
    assert visual_params[1] == ms.TENANT


def test_legacy_vector_stream_remains_default(monkeypatch):
    monkeypatch.setattr(ms, "EMBEDDING_INDEX_RETRIEVAL_ENABLED", False)
    monkeypatch.setattr(ms, "embed_query", lambda _query: [0.25] * 384)
    pool = FakePool([[]])

    results = ms._stream_vector(  # noqa: SLF001
        pool,
        "xrdp recovery",
        as_of=None,
        scope="device:alpha",
        type_filter="segment",
        limit=5,
    )

    assert results == []
    sql, params = pool.cursor_obj.executions[0]
    assert "FROM preserve.segment s" in sql
    assert "s.embedding IS NOT NULL" in sql
    assert "FROM preserve.embedding_index" not in sql
    assert params[-1] == 15


def test_embedding_index_vector_stream_keeps_memory_type_filter_unwired(monkeypatch):
    monkeypatch.setattr(ms, "EMBEDDING_INDEX_RETRIEVAL_ENABLED", True)
    monkeypatch.setattr(ms, "embed_query", lambda _query: [0.25] * 384)
    pool = FakePool([])

    results = ms._stream_vector(  # noqa: SLF001
        pool,
        "xrdp recovery",
        as_of=None,
        scope="device:alpha",
        type_filter="memory",
        limit=5,
    )

    assert results == []
    assert pool.cursor_obj.executions == []
