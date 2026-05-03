from datetime import datetime, timezone

from psycopg.errors import UndefinedTable

from mcp.memory_search import (
    memory_before_after,
    memory_causal_chain,
    memory_failed_remediations,
    memory_next_step,
    memory_search_visual,
    memory_search_procedure,
    memory_timeline,
    memory_what_did_we_try,
)


class FakeCursor:
    def __init__(self, rows):
        self.responses = rows if rows and isinstance(rows[0], list) else [rows]
        self.executed = None
        self.params = None
        self.executions = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params):
        self.executed = sql
        self.params = params
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
    def __init__(self, rows):
        self.cursor_obj = FakeCursor(rows)

    def connection(self):
        return FakeConnection(self.cursor_obj)


class RaisingCursor(FakeCursor):
    def __init__(self, exc):
        super().__init__([])
        self.exc = exc

    def execute(self, sql, params):
        self.executed = sql
        self.params = params
        self.executions.append((sql, params))
        raise self.exc


class RaisingPool:
    def __init__(self, exc):
        self.cursor_obj = RaisingCursor(exc)

    def connection(self):
        return FakeConnection(self.cursor_obj)


class RaisingOnceCursor(FakeCursor):
    def __init__(self, exc, rows):
        super().__init__(rows)
        self.exc = exc
        self.raised = False

    def execute(self, sql, params):
        self.executed = sql
        self.params = params
        self.executions.append((sql, params))
        if not self.raised:
            self.raised = True
            raise self.exc


class RaisingOncePool:
    def __init__(self, exc, rows):
        self.cursor_obj = RaisingOnceCursor(exc, rows)

    def connection(self):
        return FakeConnection(self.cursor_obj)


def test_memory_timeline_returns_ordered_event_frame_shape():
    rows = [{
        "event_frame_id": "11111111-1111-1111-1111-111111111111",
        "episode_id": "22222222-2222-2222-2222-222222222222",
        "source_fact_id": "33333333-3333-3333-3333-333333333333",
        "event_type": "remediation",
        "actor": "xrdp",
        "action": "fix_summary",
        "target": None,
        "location": "BrainCore",
        "object_value": {"step": "restart service"},
        "time_start": datetime(2026, 4, 26, 1, 2, 3, tzinfo=timezone.utc),
        "time_end": None,
        "outcome": "restart service",
        "confidence": 0.91,
        "assertion_class": "human_curated",
        "scope_path": "project:braincore",
        "evidence_segment_id": "44444444-4444-4444-4444-444444444444",
        "evidence_excerpt": "Ran restart and verified recovery.",
        "evidence_source_relpath": "incidents/example/notes.md",
        "evidence_line_start": 12,
        "evidence_line_end": 14,
    }]
    pool = FakePool(rows)

    result = memory_timeline(
        pool,
        subject="xrdp",
        scope="project:braincore",
        event_type="remediation",
        from_ts="2026-04-26T00:00:00Z",
        to_ts="2026-04-27T00:00:00Z",
        limit=10,
    )

    assert result["subject"] == "xrdp"
    assert len(result["entries"]) == 1
    entry = result["entries"][0]
    assert entry["event_frame_id"] == "11111111-1111-1111-1111-111111111111"
    assert entry["event_type"] == "remediation"
    assert entry["actor"] == "xrdp"
    assert entry["action"] == "fix_summary"
    assert entry["scope_path"] == "project:braincore"
    assert entry["evidence"] == [{
        "segment_id": "44444444-4444-4444-4444-444444444444",
        "excerpt": "Ran restart and verified recovery.",
        "source_relpath": "incidents/example/notes.md",
        "line_start": 12,
        "line_end": 14,
    }]
    assert "FROM preserve.event_frame ef" in pool.cursor_obj.executed
    assert "ef.tenant = %s" in pool.cursor_obj.executed
    assert "ef.scope_path LIKE %s" in pool.cursor_obj.executed
    assert "ef.event_type = %s" in pool.cursor_obj.executed
    assert pool.cursor_obj.params[-1] == 10


def test_memory_search_visual_returns_metadata_without_raw_paths():
    rows = [{
        "result_type": "visual_region",
        "media_artifact_id": "11111111-1111-1111-1111-111111111111",
        "visual_region_id": "22222222-2222-2222-2222-222222222222",
        "media_type": "screenshot",
        "mime_type": "image/png",
        "scope_path": "device:server-a",
        "page_number": 1,
        "region_type": "text_block",
        "label": "Error banner",
        "text": "xrdp session error",
        "artifact_id": "33333333-3333-3333-3333-333333333333",
        "source_segment_id": "44444444-4444-4444-4444-444444444444",
        "linked_entity_id": None,
        "linked_fact_id": "55555555-5555-5555-5555-555555555555",
        "linked_memory_id": None,
        "linked_procedure_id": None,
        "x_min": 0.1,
        "y_min": 0.2,
        "x_max": 0.8,
        "y_max": 0.4,
        "confidence": 0.92,
        "ingest_run_id": "66666666-6666-6666-6666-666666666666",
        "ingest_batch_key": "batch-1",
    }]
    pool = FakePool(rows)

    result = memory_search_visual(
        pool,
        query="xrdp",
        scope="device:server-a",
        media_type="screenshot",
        limit=5,
    )

    assert result["query"] == "xrdp"
    assert len(result["results"]) == 1
    item = result["results"][0]
    assert item["result_type"] == "visual_region"
    assert item["text"] == "xrdp session error"
    assert item["bbox"] == {"x_min": 0.1, "y_min": 0.2, "x_max": 0.8, "y_max": 0.4}
    assert "original_path" not in item
    assert "FROM preserve.visual_region vr" in pool.cursor_obj.executed
    assert "JOIN preserve.media_artifact ma" in pool.cursor_obj.executed
    assert "vr.tenant = %s" in pool.cursor_obj.executed
    assert "ma.original_path" not in pool.cursor_obj.executed
    assert pool.cursor_obj.params[0] == memory_search_visual.__globals__["TENANT"]
    assert pool.cursor_obj.params[-1] == 5


def test_memory_before_after_returns_chronological_sides():
    before_rows = [
        {
            "event_frame_id": "11111111-1111-1111-1111-111111111111",
            "episode_id": "22222222-2222-2222-2222-222222222222",
            "source_fact_id": "33333333-3333-3333-3333-333333333333",
            "event_type": "cause",
            "actor": "nginx",
            "action": "certificate expired",
            "target": None,
            "location": None,
            "object_value": {"note": "expired cert"},
            "time_start": datetime(2026, 2, 15, 9, 0, 0, tzinfo=timezone.utc),
            "time_end": None,
            "outcome": None,
            "confidence": 0.95,
            "assertion_class": "deterministic",
            "scope_path": "device:server-a",
            "evidence_segment_id": "44444444-4444-4444-4444-444444444444",
            "evidence_excerpt": "certificate expired causing 502",
            "evidence_source_relpath": "incidents/INC-003/notes.md",
            "evidence_line_start": 1,
            "evidence_line_end": 2,
        }
    ]
    after_rows = [
        {
            "event_frame_id": "55555555-5555-5555-5555-555555555555",
            "episode_id": "22222222-2222-2222-2222-222222222222",
            "source_fact_id": "66666666-6666-6666-6666-666666666666",
            "event_type": "remediation",
            "actor": "nginx",
            "action": "certbot renewal",
            "target": None,
            "location": None,
            "object_value": {"note": "enabled timer"},
            "time_start": datetime(2026, 2, 15, 10, 30, 0, tzinfo=timezone.utc),
            "time_end": None,
            "outcome": "service restored",
            "confidence": 0.9,
            "assertion_class": "human_curated",
            "scope_path": "device:server-a",
            "evidence_segment_id": "77777777-7777-7777-7777-777777777777",
            "evidence_excerpt": "certbot renewal restored nginx",
            "evidence_source_relpath": "incidents/INC-003/notes.md",
            "evidence_line_start": 3,
            "evidence_line_end": 4,
        }
    ]
    pool = FakePool([before_rows, after_rows])

    result = memory_before_after(
        pool,
        timestamp="2026-02-15T10:00:00Z",
        subject="nginx",
        scope="device:server-a",
        limit_each=2,
    )

    assert result["timestamp"] == "2026-02-15T10:00:00Z"
    assert [entry["event_frame_id"] for entry in result["before"]] == [
        "11111111-1111-1111-1111-111111111111",
    ]
    assert [entry["event_frame_id"] for entry in result["after"]] == [
        "55555555-5555-5555-5555-555555555555",
    ]
    assert result["before"][0]["evidence"][0]["excerpt"] == "certificate expired causing 502"
    assert result["after"][0]["evidence"][0]["excerpt"] == "certbot renewal restored nginx"
    assert len(pool.cursor_obj.executions) == 2
    before_sql, before_params = pool.cursor_obj.executions[0]
    after_sql, after_params = pool.cursor_obj.executions[1]
    assert "ef.time_start < %s::timestamptz" in before_sql
    assert "ef.time_start >= %s::timestamptz" in after_sql
    assert "ef.tenant = %s" in before_sql
    assert "ef.scope_path LIKE %s" in after_sql
    assert before_params[-2:] == ["2026-02-15T10:00:00Z", 2]
    assert after_params[-2:] == ["2026-02-15T10:00:00Z", 2]


def test_memory_causal_chain_groups_ordered_steps_by_episode():
    rows = [
        {
            "episode_id": "22222222-2222-2222-2222-222222222222",
            "episode_title": "nginx certificate outage",
            "episode_outcome": "resolved",
            "episode_scope_path": "device:server-a",
            "event_frame_id": "11111111-1111-1111-1111-111111111111",
            "source_fact_id": "33333333-3333-3333-3333-333333333333",
            "event_type": "cause",
            "actor": "nginx",
            "action": "certificate expired",
            "target": None,
            "location": None,
            "object_value": {"note": "expired cert"},
            "time_start": datetime(2026, 2, 15, 9, 0, 0, tzinfo=timezone.utc),
            "time_end": None,
            "outcome": None,
            "confidence": 0.95,
            "assertion_class": "deterministic",
            "scope_path": "device:server-a",
            "evidence_segment_id": "44444444-4444-4444-4444-444444444444",
            "evidence_excerpt": "certificate expired causing 502",
            "evidence_source_relpath": "incidents/INC-003/notes.md",
            "evidence_line_start": 1,
            "evidence_line_end": 2,
        },
        {
            "episode_id": "22222222-2222-2222-2222-222222222222",
            "episode_title": "nginx certificate outage",
            "episode_outcome": "resolved",
            "episode_scope_path": "device:server-a",
            "event_frame_id": "55555555-5555-5555-5555-555555555555",
            "source_fact_id": "66666666-6666-6666-6666-666666666666",
            "event_type": "remediation",
            "actor": "nginx",
            "action": "certbot renewal",
            "target": None,
            "location": None,
            "object_value": {"note": "enabled timer"},
            "time_start": datetime(2026, 2, 15, 10, 30, 0, tzinfo=timezone.utc),
            "time_end": None,
            "outcome": "service restored",
            "confidence": 0.9,
            "assertion_class": "human_curated",
            "scope_path": "device:server-a",
            "evidence_segment_id": "77777777-7777-7777-7777-777777777777",
            "evidence_excerpt": "certbot renewal restored nginx",
            "evidence_source_relpath": "incidents/INC-003/notes.md",
            "evidence_line_start": 3,
            "evidence_line_end": 4,
        },
    ]
    pool = FakePool(rows)

    result = memory_causal_chain(
        pool,
        subject="nginx",
        scope="device:server-a",
        from_ts="2026-02-15T00:00:00Z",
        to_ts="2026-02-16T00:00:00Z",
        limit=5,
    )

    assert result["subject"] == "nginx"
    assert len(result["chains"]) == 1
    chain = result["chains"][0]
    assert chain["episode_id"] == "22222222-2222-2222-2222-222222222222"
    assert chain["title"] == "nginx certificate outage"
    assert chain["outcome"] == "resolved"
    assert [step["event_type"] for step in chain["steps"]] == ["cause", "remediation"]
    assert chain["steps"][0]["evidence"][0]["excerpt"] == "certificate expired causing 502"
    assert "WITH matching_episodes AS" in pool.cursor_obj.executed
    assert "ef.tenant = %s" in pool.cursor_obj.executed
    assert "ep.tenant = %s" in pool.cursor_obj.executed
    assert "ef.scope_path LIKE %s" in pool.cursor_obj.executed
    assert "ef.event_type IN" in pool.cursor_obj.executed
    assert "ef.time_start IS NOT NULL" in pool.cursor_obj.executed


def test_memory_search_procedure_returns_steps(monkeypatch):
    monkeypatch.setitem(memory_search_procedure.__globals__, "EMBEDDING_INDEX_RETRIEVAL_ENABLED", False)
    rows = [{
        "procedure_id": "11111111-1111-1111-1111-111111111111",
        "title": "Procedure: restart worker",
        "summary": "restart worker safely",
        "confidence": 0.84,
        "scope_path": "project:braincore",
        "source_fact_id": "22222222-2222-2222-2222-222222222222",
        "procedure_step_id": "33333333-3333-3333-3333-333333333333",
        "step_index": 1,
        "action": "Restart worker",
        "expected_result": "worker is healthy",
    }]
    pool = FakePool(rows)

    result = memory_search_procedure(
        pool,
        query="restart worker",
        scope="project:braincore",
        limit=5,
    )

    assert result["query"] == "restart worker"
    assert len(result["results"]) == 1
    procedure = result["results"][0]
    assert procedure["procedure_id"] == "11111111-1111-1111-1111-111111111111"
    assert procedure["steps"] == [{
        "step_index": 1,
        "action": "Restart worker",
        "expected_result": "worker is healthy",
    }]
    assert "FROM preserve.procedure p" in pool.cursor_obj.executed
    assert "FROM preserve.embedding_index ei" not in pool.cursor_obj.executed
    assert "p.tenant = %s" in pool.cursor_obj.executed
    assert "p.scope_path LIKE %s" in pool.cursor_obj.executed
    assert "LEFT JOIN preserve.procedure_step ps" in pool.cursor_obj.executed


def test_memory_search_procedure_uses_embedding_index_when_enabled(monkeypatch):
    monkeypatch.setitem(memory_search_procedure.__globals__, "EMBEDDING_INDEX_RETRIEVAL_ENABLED", True)
    monkeypatch.setitem(memory_search_procedure.__globals__, "embed_query", lambda _query: [0.25] * 384)
    tenant = memory_search_procedure.__globals__["TENANT"]
    rows = [{
        "procedure_id": "11111111-1111-1111-1111-111111111111",
        "title": "Procedure: restart worker",
        "summary": "restart worker safely",
        "confidence": 0.84,
        "scope_path": "project:braincore",
        "source_fact_id": "22222222-2222-2222-2222-222222222222",
        "procedure_step_id": "33333333-3333-3333-3333-333333333333",
        "step_index": 1,
        "action": "Restart worker",
        "expected_result": "worker is healthy",
    }]
    pool = FakePool(rows)

    result = memory_search_procedure(
        pool,
        query="restart worker",
        scope="project:braincore",
        limit=5,
    )

    assert result["query"] == "restart worker"
    assert len(result["results"]) == 1
    assert result["results"][0]["steps"][0]["action"] == "Restart worker"
    sql = pool.cursor_obj.executed
    assert "FROM preserve.embedding_index ei" in sql
    assert "JOIN preserve.procedure p" in sql
    assert "ei.vector_role = 'procedure'" in sql
    assert "ei.target_kind = 'procedure'" in sql
    assert "p.tenant = %s" in sql
    assert "p.scope_path LIKE %s" in sql
    assert "LEFT JOIN preserve.procedure_step ps" in sql
    assert pool.cursor_obj.params[0].startswith("[")
    assert pool.cursor_obj.params == [
        pool.cursor_obj.params[0],
        tenant,
        tenant,
        "project:braincore%",
        pool.cursor_obj.params[0],
        5,
        tenant,
        tenant,
    ]


def test_memory_search_procedure_embedding_index_missing_returns_empty(monkeypatch):
    monkeypatch.setitem(memory_search_procedure.__globals__, "EMBEDDING_INDEX_RETRIEVAL_ENABLED", True)
    monkeypatch.setitem(memory_search_procedure.__globals__, "embed_query", lambda _query: [0.25] * 384)
    pool = RaisingPool(UndefinedTable("preserve.embedding_index"))

    result = memory_search_procedure(
        pool,
        query="restart worker",
        scope="project:braincore",
        limit=5,
    )

    assert result["query"] == "restart worker"
    assert result["results"] == []
    assert isinstance(result["query_time_ms"], float)
    assert "FROM preserve.embedding_index ei" in pool.cursor_obj.executed


def test_memory_search_procedure_falls_back_when_lifecycle_overlay_missing(monkeypatch):
    monkeypatch.setitem(memory_search_procedure.__globals__, "EMBEDDING_INDEX_RETRIEVAL_ENABLED", False)
    rows = [{
        "procedure_id": "11111111-1111-1111-1111-111111111111",
        "title": "Procedure: restart worker",
        "summary": "restart worker safely",
        "confidence": 0.84,
        "scope_path": "project:braincore",
        "source_fact_id": "22222222-2222-2222-2222-222222222222",
        "procedure_step_id": "33333333-3333-3333-3333-333333333333",
        "step_index": 1,
        "action": "Restart worker",
        "expected_result": "worker is healthy",
    }]
    pool = RaisingOncePool(UndefinedTable("preserve.lifecycle_target_intelligence"), rows)

    result = memory_search_procedure(
        pool,
        query="restart worker",
        scope="project:braincore",
        limit=5,
    )

    assert len(result["results"]) == 1
    first_sql, _first_params = pool.cursor_obj.executions[0]
    retry_sql, _retry_params = pool.cursor_obj.executions[1]
    assert "preserve.lifecycle_target_intelligence" in first_sql
    assert "preserve.lifecycle_target_intelligence" not in retry_sql


def procedure_operational_row(outcome="resolved"):
    return {
        "procedure_id": "11111111-1111-1111-1111-111111111111",
        "procedure_title": "Procedure: restart worker",
        "procedure_summary": "restart worker safely",
        "scope_path": "project:braincore",
        "procedure_source_fact_id": "22222222-2222-2222-2222-222222222222",
        "procedure_evidence_segment_id": "33333333-3333-3333-3333-333333333333",
        "episode_outcome": outcome,
        "step_id": "44444444-4444-4444-4444-444444444444",
        "step_index": 2,
        "action": "Restart worker",
        "expected_result": "worker healthy",
        "step_source_fact_id": "55555555-5555-5555-5555-555555555555",
        "step_evidence_segment_id": "66666666-6666-6666-6666-666666666666",
        "confidence": 0.84,
    }


def test_memory_next_step_returns_evidence_and_outcome():
    pool = FakePool([procedure_operational_row()])

    result = memory_next_step(
        pool,
        query="restart worker",
        scope="project:braincore",
        completed_steps=1,
        limit=5,
    )

    assert result["results"][0]["step_index"] == 2
    assert result["results"][0]["step_evidence_segment_id"] == "66666666-6666-6666-6666-666666666666"
    assert result["results"][0]["episode_outcome"] == "resolved"
    assert "JOIN LATERAL" in pool.cursor_obj.executed
    assert "ps.step_index > %s" in pool.cursor_obj.executed
    assert "p.tenant = %s" in pool.cursor_obj.executed


def test_memory_next_step_falls_back_when_lifecycle_overlay_missing():
    pool = RaisingOncePool(UndefinedTable("preserve.lifecycle_target_intelligence"), [procedure_operational_row()])

    result = memory_next_step(
        pool,
        query="restart worker",
        scope="project:braincore",
        completed_steps=1,
        limit=5,
    )

    assert len(result["results"]) == 1
    first_sql, _first_params = pool.cursor_obj.executions[0]
    retry_sql, _retry_params = pool.cursor_obj.executions[1]
    assert "preserve.lifecycle_target_intelligence" in first_sql
    assert "preserve.lifecycle_target_intelligence" not in retry_sql


def test_memory_what_did_we_try_returns_prior_steps():
    pool = FakePool([procedure_operational_row()])

    result = memory_what_did_we_try(
        pool,
        query="restart worker",
        scope="project:braincore",
        limit=5,
    )

    assert result["results"][0]["expected_result"] == "worker healthy"
    assert result["results"][0]["procedure_evidence_segment_id"] == "33333333-3333-3333-3333-333333333333"
    assert "JOIN preserve.procedure_step ps" in pool.cursor_obj.executed
    assert "LEFT JOIN preserve.episode ep" in pool.cursor_obj.executed
    assert "ps.action ILIKE" in pool.cursor_obj.executed


def test_memory_what_did_we_try_falls_back_when_lifecycle_overlay_missing():
    pool = RaisingOncePool(UndefinedTable("preserve.lifecycle_target_intelligence"), [procedure_operational_row()])

    result = memory_what_did_we_try(
        pool,
        query="restart worker",
        scope="project:braincore",
        limit=5,
    )

    assert len(result["results"]) == 1
    first_sql, _first_params = pool.cursor_obj.executions[0]
    retry_sql, _retry_params = pool.cursor_obj.executions[1]
    assert "preserve.lifecycle_target_intelligence" in first_sql
    assert "preserve.lifecycle_target_intelligence" not in retry_sql


def test_memory_failed_remediations_filters_failed_outcomes():
    pool = FakePool([procedure_operational_row(outcome="failed")])

    result = memory_failed_remediations(
        pool,
        query="restart worker",
        scope="project:braincore",
        limit=5,
    )

    assert result["results"][0]["episode_outcome"] == "failed"
    assert "lower(COALESCE(ep.outcome, '')) ~ %s" in pool.cursor_obj.executed
    assert "lower(COALESCE(ps.expected_result, '')) ~ %s" in pool.cursor_obj.executed


def test_memory_failed_remediations_falls_back_when_lifecycle_overlay_missing():
    pool = RaisingOncePool(UndefinedTable("preserve.lifecycle_target_intelligence"), [procedure_operational_row(outcome="failed")])

    result = memory_failed_remediations(
        pool,
        query="restart worker",
        scope="project:braincore",
        limit=5,
    )

    assert len(result["results"]) == 1
    first_sql, _first_params = pool.cursor_obj.executions[0]
    retry_sql, _retry_params = pool.cursor_obj.executions[1]
    assert "preserve.lifecycle_target_intelligence" in first_sql
    assert "preserve.lifecycle_target_intelligence" not in retry_sql
