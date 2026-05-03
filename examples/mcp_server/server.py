"""Example stdio MCP server for BrainCore.

This is a minimal reference implementation showing how to expose the
BrainCore retrieval library (``mcp/memory_search.py``) over the Model
Context Protocol using FastMCP's stdio transport.

It registers the reference read tools built into the retrieval library:
``memory-search``, ``memory-timeline``, ``memory-before-after``,
``memory-causal-chain``, ``memory-search-procedure``,
``memory-search-visual``, and the
working-memory session tools. It also registers write-capable lifecycle
admin tools for trusted operator use only; they are not public
unauthenticated endpoints. Downstream deployments can add tenant-aware
or project-specific tools on top of the same library.

Two design notes worth understanding before extending this file:

1. **Namespace loading.** BrainCore's retrieval library lives in a
   top-level directory named ``mcp/`` at the repo root. That name
   collides with the PyPI ``mcp`` package that provides FastMCP. When
   Python is started from the repo root, the local ``mcp/`` directory
   shadows the installed FastMCP package and ``from mcp.server.fastmcp
   import FastMCP`` raises ``ModuleNotFoundError: No module named
   'mcp.server'``. To avoid that, this module loads BrainCore's library
   files via ``importlib.util.spec_from_file_location`` under a
   synthetic package name (``braincore_lib``). FastMCP continues to
   import from the PyPI ``mcp`` package untouched.

2. **Lazy pool creation.** The psycopg connection pool is created on
   the first tool call, not at import time. That keeps this module
   importable in environments where ``BRAINCORE_POSTGRES_DSN`` is not
   set (CI import checks, linters, MCP tool introspection). Real tool
   calls against an unconfigured server raise a clear ``RuntimeError``.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Neutralize the repo-root ``mcp/`` namespace collision BEFORE importing
# FastMCP. See the module docstring for background. If the current working
# directory contains an ``mcp/`` directory (the BrainCore retrieval library
# location), strip cwd from ``sys.path`` so the PyPI ``mcp`` package (which
# provides FastMCP) resolves instead of the local directory. This must run
# before any ``import mcp...`` statement in this file.
_cwd = os.getcwd()
if os.path.isdir(os.path.join(_cwd, "mcp")):
    _cwd_path = str(Path(_cwd).resolve())
    sys.path[:] = [
        p
        for p in sys.path
        if p
        and str(Path(p).resolve()) != _cwd_path
    ]
    for _name, _module in list(sys.modules.items()):
        if _name == "mcp" or _name.startswith("mcp."):
            _module_file = getattr(_module, "__file__", "") or ""
            if _module_file and str(Path(_module_file).resolve()).startswith(
                str(Path(_cwd_path) / "mcp")
            ):
                del sys.modules[_name]

from mcp.server.fastmcp import FastMCP  # noqa: E402
from psycopg_pool import ConnectionPool  # noqa: E402

# ---------------------------------------------------------------------------
# Locate and load BrainCore's retrieval library under a synthetic package
# name so we do not shadow the PyPI ``mcp`` package (which provides
# FastMCP). The library lives at ``<repo_root>/mcp/`` relative to this
# file: ``examples/mcp_server/server.py`` -> ``../../mcp/``.
# ---------------------------------------------------------------------------

_LIB_DIR = (Path(__file__).resolve().parent / ".." / ".." / "mcp").resolve()
_SYNTH_PKG = "braincore_lib"


def _load_module(module_name: str, file_path: Path) -> types.ModuleType:
    """Load a single BrainCore library file under the synthetic package."""
    spec = importlib.util.spec_from_file_location(
        f"{_SYNTH_PKG}.{module_name}",
        file_path,
    )
    if spec is None or spec.loader is None:
        raise ImportError(
            f"Could not create spec for {file_path}. "
            f"Expected BrainCore retrieval library at {_LIB_DIR}."
        )
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"{_SYNTH_PKG}.{module_name}"] = module
    spec.loader.exec_module(module)
    return module


def _bootstrap_library() -> tuple[Any, ...]:
    """Install the synthetic package and load memory_models, embedder,
    memory_search. Returns search/timeline functions and response models.

    If ``<repo_root>/mcp/embedder.py`` is unavailable, install a
    zero-vector stub so the library can be imported. Vector-stream
    retrieval will return no candidates until a real embedder is
    provided; FTS, structured, and temporal streams continue to work.
    """
    if not _LIB_DIR.is_dir():
        raise RuntimeError(
            f"BrainCore retrieval library not found at {_LIB_DIR}. "
            f"This example expects to be run from within a BrainCore "
            f"checkout at examples/mcp_server/."
        )

    # Register the synthetic parent package.
    if _SYNTH_PKG not in sys.modules:
        pkg = types.ModuleType(_SYNTH_PKG)
        pkg.__path__ = [str(_LIB_DIR)]  # type: ignore[attr-defined]
        sys.modules[_SYNTH_PKG] = pkg

    # memory_models has no internal dependencies, load it first.
    mm = _load_module("memory_models", _LIB_DIR / "memory_models.py")

    # embedder is a dependency of memory_search. Use the repo copy if
    # present, otherwise install a zero-vector stub.
    embedder_path = _LIB_DIR / "embedder.py"
    if embedder_path.is_file():
        _load_module("embedder", embedder_path)
    else:
        import numpy as np  # local import to keep module-top-level light

        stub = types.ModuleType(f"{_SYNTH_PKG}.embedder")

        def embed_query(text: str):  # noqa: ARG001  # signature match
            return np.zeros(384, dtype=np.float32)

        stub.embed_query = embed_query  # type: ignore[attr-defined]
        sys.modules[f"{_SYNTH_PKG}.embedder"] = stub

    ms = _load_module("memory_search", _LIB_DIR / "memory_search.py")

    return (
        ms.memory_search,
        ms.memory_timeline,
        ms.memory_before_after,
        ms.memory_causal_chain,
        ms.memory_search_procedure,
        ms.memory_next_step,
        ms.memory_what_did_we_try,
        ms.memory_failed_remediations,
        ms.memory_session_start,
        ms.memory_session_update,
        ms.memory_session_close,
        ms.memory_session_list_active,
        ms.memory_working_add,
        ms.memory_working_list,
        ms.memory_working_mark_promotion_candidate,
        ms.memory_working_cleanup_expired,
        ms.lifecycle_event_enqueue,
        ms.lifecycle_event_list,
        ms.lifecycle_event_retry,
        ms.lifecycle_intelligence_backfill,
        ms.lifecycle_stats,
        ms.memory_lifecycle_status_set,
        ms.memory_lifecycle_feedback_record,
        ms.context_recall_audit_record,
        ms.memory_search_visual,
        mm.MemorySearchRequest,
        mm.MemorySearchResponse,
        mm.MemoryTimelineRequest,
        mm.TimelineResponse,
        mm.MemoryBeforeAfterRequest,
        mm.BeforeAfterResponse,
        mm.MemoryCausalChainRequest,
        mm.CausalChainResponse,
        mm.MemoryProcedureSearchRequest,
        mm.ProcedureSearchResponse,
        mm.ProcedureOperationalResponse,
        mm.TaskSessionResponse,
        mm.TaskSessionListResponse,
        mm.WorkingMemoryResponse,
        mm.WorkingMemoryListResponse,
        mm.WorkingMemoryCleanupResponse,
        mm.LifecycleEventResponse,
        mm.LifecycleEventListResponse,
        mm.LifecycleRetryResponse,
        mm.LifecycleBackfillResponse,
        mm.LifecycleStatsResponse,
        mm.LifecycleStatusResponse,
        mm.LifecycleFeedbackResponse,
        mm.ContextRecallAuditResponse,
        mm.VisualSearchRequest,
        mm.VisualSearchResponse,
    )


(
    _memory_search,
    _memory_timeline,
    _memory_before_after,
    _memory_causal_chain,
    _memory_search_procedure,
    _memory_next_step,
    _memory_what_did_we_try,
    _memory_failed_remediations,
    _memory_session_start,
    _memory_session_update,
    _memory_session_close,
    _memory_session_list_active,
    _memory_working_add,
    _memory_working_list,
    _memory_working_mark_promotion_candidate,
    _memory_working_cleanup_expired,
    _lifecycle_event_enqueue,
    _lifecycle_event_list,
    _lifecycle_event_retry,
    _lifecycle_intelligence_backfill,
    _lifecycle_stats,
    _memory_lifecycle_status_set,
    _memory_lifecycle_feedback_record,
    _context_recall_audit_record,
    _memory_search_visual,
    MemorySearchRequest,
    MemorySearchResponse,
    MemoryTimelineRequest,
    TimelineResponse,
    MemoryBeforeAfterRequest,
    BeforeAfterResponse,
    MemoryCausalChainRequest,
    CausalChainResponse,
    MemoryProcedureSearchRequest,
    ProcedureSearchResponse,
    ProcedureOperationalResponse,
    TaskSessionResponse,
    TaskSessionListResponse,
    WorkingMemoryResponse,
    WorkingMemoryListResponse,
    WorkingMemoryCleanupResponse,
    LifecycleEventResponse,
    LifecycleEventListResponse,
    LifecycleRetryResponse,
    LifecycleBackfillResponse,
    LifecycleStatsResponse,
    LifecycleStatusResponse,
    LifecycleFeedbackResponse,
    ContextRecallAuditResponse,
    VisualSearchRequest,
    VisualSearchResponse,
) = _bootstrap_library()


# ---------------------------------------------------------------------------
# FastMCP app (instantiated at module scope so CI can introspect it
# without touching the database).
# ---------------------------------------------------------------------------

app = FastMCP("braincore-example-mcp")

# Deferred connection pool. Created on first tool invocation.
_pool: Optional[ConnectionPool] = None


def _get_pool() -> ConnectionPool:
    """Return the process-wide psycopg connection pool.

    Creates the pool on first call. Raises ``RuntimeError`` with a clear
    remediation message if ``BRAINCORE_POSTGRES_DSN`` is not set.

    Deferring pool construction is intentional: it lets ``server.py`` be
    imported in environments without a database (CI import checks,
    linters, MCP tool introspection) while still failing loudly when a
    real tool call is attempted against an unconfigured server.
    """
    global _pool
    if _pool is not None:
        return _pool

    dsn = os.environ.get("BRAINCORE_POSTGRES_DSN")
    if not dsn:
        raise RuntimeError(
            "BRAINCORE_POSTGRES_DSN is not set. Export it to a libpq DSN "
            "pointing at a BrainCore preserve-schema database, for example:\n"
            "  export BRAINCORE_POSTGRES_DSN='<libpq DSN>'\n"
            "The target database must have migrations 001-020 applied."
        )

    _pool = ConnectionPool(conninfo=dsn, min_size=1, max_size=4, open=True)
    return _pool


@app.tool(name="memory-search")
def memory_search_tool(
    query: str,
    limit: int = 10,
    type_filter: Optional[str] = None,
    as_of: Optional[str] = None,
    scope: Optional[str] = None,
    include_graph: bool = False,
    explain_paths: bool = False,
) -> dict[str, Any]:
    """Hybrid retrieval (SQL + FTS + vector + temporal, optional graph, fused with RRF) over the preserve schema. Returns facts, memories, segments, and episodes.

    Args:
        query: Natural-language search string.
        limit: Maximum number of results to return (1-100, default 10).
        type_filter: Optional object-type filter. One of
            ``fact``, ``memory``, ``segment``, ``episode``.
        as_of: Optional ISO-8601 timestamp for temporal filtering
            (default: current time).
        scope: Optional scope-path prefix filter
            (for example, ``device:server-a``).
        include_graph: Enables the feature-flagged graph-path stream.
        explain_paths: Includes path explanations when graph or expansion
            candidates supply them.

    Returns:
        A JSON-serializable dict with three keys:

        - ``results``: list of result objects (``object_id``,
          ``object_type``, ``title``, ``summary``, ``confidence``,
          ``score``, ``valid_from``, ``valid_to``, ``evidence``,
          ``scope_path``).
        - ``query_time_ms``: float, end-to-end query latency.
        - ``stream_counts``: dict of candidate counts per retrieval stream
          (``structured``, ``fts``, ``vector``, ``temporal``).
    """
    # Validate inputs through the Pydantic request model so the tool
    # exposes the same contract as the rest of the retrieval library.
    request = MemorySearchRequest(
        query=query,
        limit=limit,
        type_filter=type_filter,  # type: ignore[arg-type]
        as_of=as_of,
        scope=scope,
        include_graph=include_graph,
        explain_paths=explain_paths,
    )

    pool = _get_pool()
    raw = _memory_search(
        pool,
        query=request.query,
        as_of=request.as_of,
        scope=request.scope,
        type_filter=request.type_filter,
        limit=request.limit,
        include_graph=request.include_graph,
        explain_paths=request.explain_paths,
    )

    # Round-trip through the response model for shape validation and to
    # guarantee JSON-safe primitive types in the returned dict.
    response = MemorySearchResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-timeline")
def memory_timeline_tool(
    subject: Optional[str] = None,
    scope: Optional[str] = None,
    event_type: Optional[str] = None,
    from_ts: Optional[str] = None,
    to_ts: Optional[str] = None,
    include_evidence: bool = True,
    limit: int = 50,
) -> dict[str, Any]:
    """Return an ordered event-frame timeline with provenance pointers.

    Args:
        subject: Optional entity-name filter matched against actor, target,
            or location.
        scope: Optional scope-path prefix filter.
        event_type: Optional event frame type, such as ``cause`` or
            ``remediation``.
        from_ts: Optional inclusive lower timestamp bound.
        to_ts: Optional exclusive upper timestamp bound.
        include_evidence: Include segment evidence metadata when present.
        limit: Maximum number of entries to return (1-200, default 50).

    Returns:
        A JSON-serializable timeline containing ordered event frames and
        evidence links.
    """
    request = MemoryTimelineRequest(
        subject=subject,
        scope=scope,
        event_type=event_type,
        from_ts=from_ts,
        to_ts=to_ts,
        include_evidence=include_evidence,
        limit=limit,
    )
    raw = _memory_timeline(
        _get_pool(),
        subject=request.subject,
        scope=request.scope,
        event_type=request.event_type,
        from_ts=request.from_ts,
        to_ts=request.to_ts,
        include_evidence=request.include_evidence,
        limit=request.limit,
    )
    response = TimelineResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-before-after")
def memory_before_after_tool(
    timestamp: str,
    subject: Optional[str] = None,
    scope: Optional[str] = None,
    event_type: Optional[str] = None,
    include_evidence: bool = True,
    limit_each: int = 3,
) -> dict[str, Any]:
    """Return nearest event frames before and after a timestamp.

    Args:
        timestamp: ISO-8601 timestamp used as the pivot.
        subject: Optional entity-name filter matched against actor, target,
            or location.
        scope: Optional scope-path prefix filter.
        event_type: Optional event frame type, such as ``cause`` or
            ``remediation``.
        include_evidence: Include segment evidence metadata when present.
        limit_each: Maximum entries to return on each side (1-50, default 3).

    Returns:
        A JSON-serializable response with ``before`` and ``after`` event-frame
        lists, each ordered chronologically.
    """
    request = MemoryBeforeAfterRequest(
        timestamp=timestamp,
        subject=subject,
        scope=scope,
        event_type=event_type,
        include_evidence=include_evidence,
        limit_each=limit_each,
    )
    raw = _memory_before_after(
        _get_pool(),
        timestamp=request.timestamp,
        subject=request.subject,
        scope=request.scope,
        event_type=request.event_type,
        include_evidence=request.include_evidence,
        limit_each=request.limit_each,
    )
    response = BeforeAfterResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-causal-chain")
def memory_causal_chain_tool(
    subject: Optional[str] = None,
    scope: Optional[str] = None,
    from_ts: Optional[str] = None,
    to_ts: Optional[str] = None,
    include_evidence: bool = True,
    limit: int = 10,
) -> dict[str, Any]:
    """Return episode-grouped causal chains from event frames.

    Args:
        subject: Optional entity-name filter used to find matching episodes.
        scope: Optional scope-path prefix filter.
        from_ts: Optional inclusive lower timestamp bound.
        to_ts: Optional exclusive upper timestamp bound.
        include_evidence: Include segment evidence metadata when present.
        limit: Maximum number of episode chains to return (1-50, default 10).

    Returns:
        A JSON-serializable response with chains grouped by episode. Each
        chain contains ordered causal event-frame steps with provenance.
    """
    request = MemoryCausalChainRequest(
        subject=subject,
        scope=scope,
        from_ts=from_ts,
        to_ts=to_ts,
        include_evidence=include_evidence,
        limit=limit,
    )
    raw = _memory_causal_chain(
        _get_pool(),
        subject=request.subject,
        scope=request.scope,
        from_ts=request.from_ts,
        to_ts=request.to_ts,
        include_evidence=request.include_evidence,
        limit=request.limit,
    )
    response = CausalChainResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-search-procedure")
def memory_search_procedure_tool(
    query: str,
    scope: Optional[str] = None,
    limit: int = 10,
) -> dict[str, Any]:
    """Search stored procedural workflow memory."""
    request = MemoryProcedureSearchRequest(
        query=query,
        scope=scope,
        limit=limit,
    )
    raw = _memory_search_procedure(
        _get_pool(),
        query=request.query,
        scope=request.scope,
        limit=request.limit,
    )
    response = ProcedureSearchResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-next-step")
def memory_next_step_tool(
    query: str,
    scope: Optional[str] = None,
    completed_steps: int = 0,
    limit: int = 10,
) -> dict[str, Any]:
    """Return the next evidence-grounded procedure step for a matching workflow."""
    raw = _memory_next_step(
        _get_pool(),
        query=query,
        scope=scope,
        completed_steps=completed_steps,
        limit=limit,
    )
    response = ProcedureOperationalResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-what-did-we-try")
def memory_what_did_we_try_tool(
    query: str,
    scope: Optional[str] = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Return prior tried procedure steps with evidence and outcome data."""
    raw = _memory_what_did_we_try(
        _get_pool(),
        query=query,
        scope=scope,
        limit=limit,
    )
    response = ProcedureOperationalResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-failed-remediations")
def memory_failed_remediations_tool(
    query: str,
    scope: Optional[str] = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Return failed prior remediation steps with evidence and outcome data."""
    raw = _memory_failed_remediations(
        _get_pool(),
        query=query,
        scope=scope,
        limit=limit,
    )
    response = ProcedureOperationalResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-session-start")
def memory_session_start_tool(
    session_key: str,
    agent_name: str,
    task_title: Optional[str] = None,
    scope: Optional[str] = None,
    ttl_days: int = 14,
) -> dict[str, Any]:
    """Start or resume a task session for ephemeral working memory."""
    raw = _memory_session_start(
        _get_pool(),
        session_key=session_key,
        agent_name=agent_name,
        task_title=task_title,
        scope=scope,
        ttl_days=ttl_days,
    )
    response = TaskSessionResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-session-update")
def memory_session_update_tool(
    session_key: str,
    status: Optional[str] = None,
    task_title: Optional[str] = None,
    scope: Optional[str] = None,
) -> dict[str, Any]:
    """Update a task session's status, title, or scope."""
    raw = _memory_session_update(
        _get_pool(),
        session_key=session_key,
        status=status,
        task_title=task_title,
        scope=scope,
    )
    response = TaskSessionResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-session-close")
def memory_session_close_tool(
    session_key: str,
    status: str = "completed",
) -> dict[str, Any]:
    """Close a task session as completed or failed."""
    raw = _memory_session_close(
        _get_pool(),
        session_key=session_key,
        status=status,
    )
    response = TaskSessionResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-session-list-active")
def memory_session_list_active_tool(
    scope: Optional[str] = None,
    limit: int = 50,
) -> dict[str, Any]:
    """List active non-expired task sessions."""
    raw = _memory_session_list_active(
        _get_pool(),
        scope=scope,
        limit=limit,
    )
    response = TaskSessionListResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-working-add")
def memory_working_add_tool(
    session_key: str,
    memory_kind: str,
    content: str,
    source_segment_id: Optional[str] = None,
    source_fact_id: Optional[str] = None,
    evidence_segment_id: Optional[str] = None,
    ttl_days: int = 14,
) -> dict[str, Any]:
    """Add an ephemeral working-memory item to an active session."""
    raw = _memory_working_add(
        _get_pool(),
        session_key=session_key,
        memory_kind=memory_kind,
        content=content,
        source_segment_id=source_segment_id,
        source_fact_id=source_fact_id,
        evidence_segment_id=evidence_segment_id,
        ttl_days=ttl_days,
    )
    response = WorkingMemoryResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-working-list")
def memory_working_list_tool(
    session_key: Optional[str] = None,
    promotion_status: Optional[str] = None,
    include_expired: bool = False,
    limit: int = 50,
) -> dict[str, Any]:
    """List working-memory items, excluding expired rows by default."""
    raw = _memory_working_list(
        _get_pool(),
        session_key=session_key,
        promotion_status=promotion_status,
        include_expired=include_expired,
        limit=limit,
    )
    response = WorkingMemoryListResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-working-mark-promotion-candidate")
def memory_working_mark_promotion_candidate_tool(
    working_memory_id: str,
    promotion_reason: str,
    promotion_target_kind: Optional[str] = None,
    promotion_target_id: Optional[str] = None,
) -> dict[str, Any]:
    """Mark a closed-session, evidence-backed item as a promotion candidate."""
    raw = _memory_working_mark_promotion_candidate(
        _get_pool(),
        working_memory_id=working_memory_id,
        promotion_reason=promotion_reason,
        promotion_target_kind=promotion_target_kind,
        promotion_target_id=promotion_target_id,
    )
    response = WorkingMemoryResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-working-cleanup-expired")
def memory_working_cleanup_expired_tool(
    limit: int = 500,
) -> dict[str, Any]:
    """Mark expired unpromoted working-memory items as expired."""
    raw = _memory_working_cleanup_expired(
        _get_pool(),
        limit=limit,
    )
    response = WorkingMemoryCleanupResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="lifecycle-event-enqueue")
def lifecycle_event_enqueue_tool(
    event_id: str,
    event_type: str,
    source_service: str,
    target_kind: Optional[str] = None,
    target_id: Optional[str] = None,
    scope: Optional[str] = None,
    session_key: Optional[str] = None,
    trace_id: Optional[str] = None,
    payload: Optional[dict[str, Any]] = None,
    evidence_refs: Optional[list[Any]] = None,
) -> dict[str, Any]:
    """Enqueue an idempotent lifecycle event."""
    raw = _lifecycle_event_enqueue(
        _get_pool(),
        event_id=event_id,
        event_type=event_type,
        source_service=source_service,
        target_kind=target_kind,
        target_id=target_id,
        scope=scope,
        session_key=session_key,
        trace_id=trace_id,
        payload=payload,
        evidence_refs=evidence_refs,
    )
    response = LifecycleEventResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="lifecycle-event-list")
def lifecycle_event_list_tool(
    status: Optional[str] = None,
    limit: int = 50,
) -> dict[str, Any]:
    """List tenant-local lifecycle outbox events."""
    raw = _lifecycle_event_list(
        _get_pool(),
        status=status,
        limit=limit,
    )
    response = LifecycleEventListResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="lifecycle-event-retry")
def lifecycle_event_retry_tool(
    outbox_id: str,
) -> dict[str, Any]:
    """Retry a failed or dead-letter lifecycle event."""
    raw = _lifecycle_event_retry(
        _get_pool(),
        outbox_id=outbox_id,
    )
    response = LifecycleRetryResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="lifecycle-intelligence-backfill")
def lifecycle_intelligence_backfill_tool(
    target_kind: str = "all",
    limit: int = 1000,
) -> dict[str, Any]:
    """Backfill lifecycle intelligence for existing tenant-local targets."""
    raw = _lifecycle_intelligence_backfill(
        _get_pool(),
        target_kind=target_kind,
        limit=limit,
    )
    response = LifecycleBackfillResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="lifecycle-stats")
def lifecycle_stats_tool() -> dict[str, Any]:
    """Show lifecycle outbox and target intelligence counts."""
    raw = _lifecycle_stats(_get_pool())
    response = LifecycleStatsResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-lifecycle-status-set")
def memory_lifecycle_status_set_tool(
    target_kind: str,
    target_id: str,
    status: str,
    reason: str,
    actor_type: str = "admin",
    actor_id: Optional[str] = None,
) -> dict[str, Any]:
    """Set lifecycle intelligence status without mutating native memory truth."""
    raw = _memory_lifecycle_status_set(
        _get_pool(),
        target_kind=target_kind,
        target_id=target_id,
        status=status,
        reason=reason,
        actor_type=actor_type,
        actor_id=actor_id,
    )
    response = LifecycleStatusResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-lifecycle-feedback-record")
def memory_lifecycle_feedback_record_tool(
    target_kind: str,
    target_id: str,
    signal: str,
    actor_type: str = "admin",
    actor_id: Optional[str] = None,
    outcome: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Append lifecycle feedback without mutating native memory truth."""
    raw = _memory_lifecycle_feedback_record(
        _get_pool(),
        target_kind=target_kind,
        target_id=target_id,
        signal=signal,
        actor_type=actor_type,
        actor_id=actor_id,
        outcome=outcome,
        details=details,
    )
    response = LifecycleFeedbackResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="context-recall-audit-record")
def context_recall_audit_record_tool(
    trigger: str,
    mode: str,
    max_tokens: int,
    injected: bool = False,
    scope: Optional[str] = None,
    session_key: Optional[str] = None,
    goal: Optional[str] = None,
    cues: Optional[list[Any]] = None,
    retrieved: Optional[list[Any]] = None,
    prompt_package: Optional[list[Any]] = None,
    omitted: Optional[list[Any]] = None,
    total_tokens: int = 0,
) -> dict[str, Any]:
    """Record context recall audit metadata."""
    raw = _context_recall_audit_record(
        _get_pool(),
        trigger=trigger,
        mode=mode,
        max_tokens=max_tokens,
        injected=injected,
        scope=scope,
        session_key=session_key,
        goal=goal,
        cues=cues,
        retrieved=retrieved,
        prompt_package=prompt_package,
        omitted=omitted,
        total_tokens=total_tokens,
    )
    response = ContextRecallAuditResponse.model_validate(raw)
    return response.model_dump(mode="json")


@app.tool(name="memory-search-visual")
def memory_search_visual_tool(
    query: str,
    scope: Optional[str] = None,
    media_type: Optional[str] = None,
    limit: int = 10,
) -> dict[str, Any]:
    """Search OCR/caption/layout metadata without returning raw artifacts."""
    request = VisualSearchRequest(
        query=query,
        scope=scope,
        media_type=media_type,
        limit=limit,
    )
    raw = _memory_search_visual(
        _get_pool(),
        query=request.query,
        scope=request.scope,
        media_type=request.media_type,
        limit=request.limit,
    )
    response = VisualSearchResponse.model_validate(raw)
    return response.model_dump(mode="json")


if __name__ == "__main__":
    # stdio transport — connect from Claude Desktop or MCP Inspector.
    app.run()
