from datetime import datetime, timezone
import os

from mcp.memory_search import (
    memory_session_list_active,
    memory_session_start,
    memory_working_add,
    memory_working_cleanup_expired,
    memory_working_list,
    memory_working_mark_promotion_candidate,
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

    def fetchone(self):
        rows = self.responses.pop(0)
        return rows[0] if rows else None

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


def session_row():
    return {
        "session_id": "11111111-1111-1111-1111-111111111111",
        "session_key": "task-1",
        "agent_name": "codex",
        "task_title": "finish upgrade",
        "status": "active",
        "scope_path": "project:braincore",
        "started_at": datetime(2026, 4, 26, tzinfo=timezone.utc),
        "last_seen_at": datetime(2026, 4, 26, tzinfo=timezone.utc),
        "ended_at": None,
        "expires_at": datetime(2026, 5, 10, tzinfo=timezone.utc),
    }


def working_row():
    return {
        "working_memory_id": "22222222-2222-2222-2222-222222222222",
        "tenant": "default",
        "session_id": "11111111-1111-1111-1111-111111111111",
        "session_key": "task-1",
        "memory_kind": "decision",
        "content": "promote the working-memory tools",
        "promotion_status": "promotion_candidate",
        "promotion_reason": "durable decision",
        "promotion_target_kind": "memory",
        "promotion_target_id": "33333333-3333-3333-3333-333333333333",
        "expires_at": datetime(2026, 5, 10, tzinfo=timezone.utc),
        "created_at": datetime(2026, 4, 26, tzinfo=timezone.utc),
    }


def test_memory_session_start_uses_default_ttl_and_upsert():
    pool = FakePool([[session_row()]])

    result = memory_session_start(
        pool,
        session_key="task-1",
        agent_name="codex",
        task_title="finish upgrade",
        scope="project:braincore",
    )

    assert result["session"]["session_key"] == "task-1"
    assert "INSERT INTO preserve.task_session" in pool.cursor_obj.executed
    assert "ON CONFLICT (tenant, session_key) DO UPDATE" in pool.cursor_obj.executed
    assert "interval '1 day'" in pool.cursor_obj.executed
    assert pool.cursor_obj.params[-1] == 14


def test_memory_session_list_active_excludes_expired():
    pool = FakePool([[session_row()]])

    result = memory_session_list_active(pool, scope="project:braincore", limit=10)

    assert len(result["sessions"]) == 1
    assert "status IN ('active', 'idle')" in pool.cursor_obj.executed
    assert "(expires_at IS NULL OR expires_at > now())" in pool.cursor_obj.executed
    assert "scope_path LIKE %s" in pool.cursor_obj.executed


def test_memory_working_add_requires_active_non_expired_session():
    pool = FakePool([[working_row()]])

    result = memory_working_add(
        pool,
        session_key="task-1",
        memory_kind="decision",
        content="promote the working-memory tools",
        evidence_segment_id="44444444-4444-4444-4444-444444444444",
    )

    assert result["item"]["working_memory_id"] == "22222222-2222-2222-2222-222222222222"
    assert "FROM preserve.task_session" in pool.cursor_obj.executed
    assert "status IN ('active', 'idle')" in pool.cursor_obj.executed
    assert "(expires_at IS NULL OR expires_at > now())" in pool.cursor_obj.executed
    assert "INSERT INTO preserve.working_memory" in pool.cursor_obj.executed


def test_memory_working_list_excludes_expired_by_default():
    pool = FakePool([[working_row()]])

    result = memory_working_list(pool, session_key="task-1")

    assert len(result["items"]) == 1
    assert "wm.expires_at > now()" in pool.cursor_obj.executed
    assert pool.cursor_obj.params[3] is False


def test_memory_working_mark_promotion_candidate_requires_closed_evidence():
    pool = FakePool([[working_row()]])

    result = memory_working_mark_promotion_candidate(
        pool,
        working_memory_id="22222222-2222-2222-2222-222222222222",
        promotion_reason="durable decision",
        promotion_target_kind="memory",
        promotion_target_id="33333333-3333-3333-3333-333333333333",
    )

    assert result["item"]["promotion_status"] == "promotion_candidate"
    assert "ts.status IN ('completed', 'failed')" in pool.cursor_obj.executed
    assert "wm.expires_at > now()" in pool.cursor_obj.executed
    assert "wm.evidence_segment_id IS NOT NULL" in pool.cursor_obj.executed


def test_memory_working_cleanup_expired_marks_unpromoted_without_deleting():
    pool = FakePool([[{"working_memory_id": "22222222-2222-2222-2222-222222222222"}]])

    result = memory_working_cleanup_expired(pool, limit=500)

    assert result["expired"] == 1
    assert "UPDATE preserve.working_memory" in pool.cursor_obj.executed
    assert "promotion_status = 'expired'" in pool.cursor_obj.executed
    assert "promotion_status IN ('not_promoted', 'promotion_candidate', 'rejected')" in pool.cursor_obj.executed
    assert "DELETE" not in pool.cursor_obj.executed.upper()
    assert pool.cursor_obj.params == [os.environ.get("BRAINCORE_TENANT", "default"), 500]
