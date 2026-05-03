from datetime import datetime, timezone

from mcp.memory_search import (
    TENANT,
    context_recall_audit_record,
    lifecycle_event_enqueue,
    lifecycle_event_list,
    lifecycle_intelligence_backfill,
    memory_lifecycle_feedback_record,
    memory_lifecycle_status_set,
)

from tests.test_working_memory_mcp import FakePool


def lifecycle_event_row():
    return {
        "outbox_id": "11111111-1111-1111-1111-111111111111",
        "tenant": "default",
        "event_id": "evt-1",
        "event_type": "memory_retrieved",
        "source_service": "agentfanout",
        "status": "pending",
        "target_kind": "memory",
        "target_id": "22222222-2222-2222-2222-222222222222",
        "attempt_count": 0,
        "received_at": datetime(2026, 5, 2, tzinfo=timezone.utc),
    }


def test_lifecycle_event_enqueue_is_idempotent_outbox_write():
    pool = FakePool([[{"exists": 1}], [lifecycle_event_row()]])

    result = lifecycle_event_enqueue(
        pool,
        event_id="evt-1",
        event_type="memory_retrieved",
        source_service="agentfanout",
        target_kind="memory",
        target_id="22222222-2222-2222-2222-222222222222",
        payload={"cues": ["release gate"]},
    )

    assert result["event"]["outbox_id"] == "11111111-1111-1111-1111-111111111111"
    executed = "\n".join(sql for sql, _params in pool.cursor_obj.executions)
    assert "FROM preserve.memory" in executed
    assert "INSERT INTO preserve.lifecycle_outbox" in executed
    assert "ON CONFLICT (tenant, idempotency_key) DO UPDATE" in executed
    assert pool.cursor_obj.params[2] == "agentfanout:evt-1"


def test_lifecycle_event_list_reads_outbox_only():
    pool = FakePool([[lifecycle_event_row()]])

    result = lifecycle_event_list(pool, status="failed", limit=20)

    assert len(result["events"]) == 1
    assert "FROM preserve.lifecycle_outbox" in pool.cursor_obj.executed
    assert "FROM preserve.memory " not in pool.cursor_obj.executed
    assert pool.cursor_obj.params[1] == "failed"


def test_lifecycle_intelligence_backfill_filters_existing_targets_before_limit():
    pool = FakePool([[{"intelligence_id": "55555555-5555-5555-5555-555555555555"}]])

    result = lifecycle_intelligence_backfill(pool, target_kind="memory", limit=10)

    assert result["inserted"] == 1
    assert "FROM preserve.memory source" in pool.cursor_obj.executed
    assert "NOT EXISTS" in pool.cursor_obj.executed
    assert "preserve.lifecycle_target_intelligence" in pool.cursor_obj.executed
    assert pool.cursor_obj.executed.index("NOT EXISTS") < pool.cursor_obj.executed.index("LIMIT")
    assert pool.cursor_obj.params == [TENANT, "memory", 10, "memory", "semantic"]


def test_memory_lifecycle_status_set_updates_lifecycle_tables_only():
    pool = FakePool([[{"exists": 1}], [
        {
            "target_kind": "memory",
            "target_id": "22222222-2222-2222-2222-222222222222",
            "lifecycle_status": "suppressed",
            "lock_version": 1,
        }
    ]])

    result = memory_lifecycle_status_set(
        pool,
        target_kind="memory",
        target_id="22222222-2222-2222-2222-222222222222",
        status="suppressed",
        reason="bad recall",
    )

    assert result["target"]["lifecycle_status"] == "suppressed"
    executed = "\n".join(sql for sql, _params in pool.cursor_obj.executions)
    assert "preserve.lifecycle_target_intelligence" in executed
    assert "preserve.lifecycle_audit_log" in executed
    assert "UPDATE preserve.memory" not in executed


def test_memory_lifecycle_feedback_record_is_append_only_surface():
    pool = FakePool([[{"exists": 1}], [{"feedback_id": "33333333-3333-3333-3333-333333333333"}]])

    result = memory_lifecycle_feedback_record(
        pool,
        target_kind="memory",
        target_id="22222222-2222-2222-2222-222222222222",
        signal="user_corrected",
    )

    assert result["feedback"]["feedback_id"] == "33333333-3333-3333-3333-333333333333"
    executed = "\n".join(sql for sql, _params in pool.cursor_obj.executions)
    assert "INSERT INTO preserve.lifecycle_feedback_event" in executed
    assert "INSERT INTO preserve.lifecycle_audit_log" in executed
    assert "UPDATE preserve.memory" not in executed


def test_memory_lifecycle_feedback_rejects_native_mutation_request():
    pool = FakePool([])

    try:
        memory_lifecycle_feedback_record(
            pool,
            target_kind="memory",
            target_id="22222222-2222-2222-2222-222222222222",
            signal="user_corrected",
            details={"requested_native_mutation": True},
        )
    except ValueError as exc:
        assert "native BrainCore truth mutation" in str(exc)
    else:
        raise AssertionError("native mutation request should be rejected")


def test_lifecycle_event_enqueue_validates_event_type_before_sql():
    pool = FakePool([])

    try:
        lifecycle_event_enqueue(
            pool,
            event_id="evt-1",
            event_type="invalid",
            source_service="agentfanout",
        )
    except ValueError as exc:
        assert "event_type must be one of" in str(exc)
    else:
        raise AssertionError("invalid event type should be rejected")


def test_context_recall_audit_record_writes_audit_payload():
    pool = FakePool([[{"context_audit_id": "44444444-4444-4444-4444-444444444444"}]])

    result = context_recall_audit_record(
        pool,
        trigger="pre_model_call",
        mode="shadow",
        max_tokens=1200,
        goal="finish upgrade",
    )

    assert result["context_audit"]["context_audit_id"] == "44444444-4444-4444-4444-444444444444"
    assert "INSERT INTO preserve.context_recall_audit" in pool.cursor_obj.executed
    assert pool.cursor_obj.params[1] == "pre_model_call"
    assert pool.cursor_obj.params[2] == "shadow"
