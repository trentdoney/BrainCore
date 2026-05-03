"""BrainCore Memory — hybrid retrieval for preserve schema.

Streams:
  1. Structured SQL   — entity name matching -> facts for that entity
  2. Full-text search — plainto_tsquery across fact, memory, segment, episode
  3. Vector search    — cosine similarity on 384-dim embeddings
  4. Temporal/Relation expansion — enrich results with related facts & episodes
  5. Graph path search — optional typed memory_edge traversal behind a flag

Fusion: Reciprocal Rank Fusion with k=60

Tenant contract:
  - Each MCP process is bound to a single tenant via BRAINCORE_TENANT.
  - Search is exact-tenant: results are restricted to that tenant only.
  - Legacy/default rows are not mixed into non-default tenant reads.
"""

from __future__ import annotations

import logging
import os
import re
import time
import hashlib
import json
from dataclasses import dataclass, field
from typing import Optional

from psycopg.rows import dict_row
from psycopg.errors import QueryCanceled, UndefinedTable
from psycopg_pool import ConnectionPool

from .embedder import embed_query

logger = logging.getLogger(__name__)

RRF_K = 60

# Tenant scoping — one process per tenant, exact tenant match only.
TENANT = os.environ.get("BRAINCORE_TENANT", "default")
GRAPH_STREAM_TIMEOUT_MS = int(os.environ.get("BRAINCORE_GRAPH_STREAM_TIMEOUT_MS", "60"))
LIGHTWEIGHT_RERANKING_ENABLED = os.environ.get("BRAINCORE_LIGHTWEIGHT_RERANKING") == "1"
EMBEDDING_INDEX_RETRIEVAL_ENABLED = os.environ.get("BRAINCORE_EMBEDDING_INDEX_RETRIEVAL") == "1"
GRAPH_ELIGIBLE_ASSERTION_CLASSES = (
    "deterministic",
    "human_curated",
    "corroborated_llm",
)
CAUSAL_CHAIN_EVENT_TYPES = (
    "cause",
    "config_change",
    "impact",
    "decision",
    "remediation",
)
DEFAULT_WORKING_MEMORY_TTL_DAYS = 14
FAILED_REMEDIATION_PATTERN = "(fail|failed|failure|unresolved|regress|regressed|unsuccessful|did not|error)"
LIFECYCLE_HIDDEN_STATUSES = ("suppressed", "retired")
LIFECYCLE_TARGET_KINDS = ("fact", "memory", "procedure", "event_frame", "working_memory")
LIFECYCLE_OUTBOX_STATUSES = ("pending", "processing", "completed", "failed", "dead_letter")
LIFECYCLE_EVENT_TYPES = (
    "mission_started", "mission_completed", "mission_failed",
    "session_started", "session_completed", "session_failed",
    "model_call_started", "model_call_completed", "model_call_failed",
    "tool_called", "tool_completed", "tool_failed",
    "approval_decided", "user_corrected", "context_compacted",
    "memory_retrieved", "memory_injected", "memory_omitted",
    "memory_feedback", "memory_written", "memory_suppressed",
    "memory_retired", "memory_promoted",
    "admin_memory_suppressed", "admin_memory_retired",
    "admin_memory_promoted", "admin_memory_disputed",
    "admin_feedback_resolved", "admin_policy_override",
    "artifact_archived", "extraction_completed", "fact_inserted",
    "memory_consolidated", "procedure_used", "working_memory_added",
    "working_memory_promoted",
)
LIFECYCLE_STATUSES = (
    "candidate", "archived", "active", "review_required",
    "validated", "disputed", "suppressed", "retired",
)
LIFECYCLE_FEEDBACK_SIGNALS = (
    "retrieved_not_injected", "injected_referenced", "injected_ignored",
    "injected_contradicted", "led_to_success", "led_to_failure",
    "user_corrected", "user_confirmed", "admin_suppressed", "admin_promoted",
)

PREDICATE_HINTS = {
    "cause": ("cause", "caused", "causing", "root cause", "why"),
    "impact": ("impact", "impacted", "affected", "down"),
    "decision": ("decision", "decided", "chose"),
    "remediation": ("fix", "fixed", "remediate", "remediation", "resolve", "repair"),
    "constraint": ("must", "should", "guardrail", "policy", "require", "depends"),
    "config_change": ("config", "changed", "setting", "parameter"),
}


@dataclass(frozen=True)
class _QueryPlan:
    entities: tuple[str, ...] = ()
    scope_hints: tuple[str, ...] = ()
    predicate_hints: tuple[str, ...] = ()
    time_hints: tuple[str, ...] = ()
    desired_answer_type: str = "general"


def _bounded_ttl_days(ttl_days: Optional[int]) -> int:
    if ttl_days is None:
        return DEFAULT_WORKING_MEMORY_TTL_DAYS
    return max(1, min(int(ttl_days), 365))


def _working_memory_fingerprint(parts: list[Optional[str]]) -> str:
    normalized = "\x1f".join((part or "").strip().lower() for part in parts)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _unique_ordered(values: list[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        normalized = value.strip().lower()
        if normalized and normalized not in seen:
            seen.add(normalized)
            ordered.append(normalized)
    return tuple(ordered)


def _require_choice(value: Optional[str], allowed: tuple[str, ...], label: str) -> None:
    if value is not None and value not in allowed:
        raise ValueError(f"{label} must be one of: {', '.join(allowed)}")


def _target_pair_valid(target_kind: Optional[str], target_id: Optional[str]) -> bool:
    return (target_kind is None and target_id is None) or (target_kind is not None and target_id is not None)


def _assert_target_exists(cur, target_kind: str, target_id: str) -> None:
    table_by_kind = {
        "fact": ("fact", "fact_id"),
        "memory": ("memory", "memory_id"),
        "procedure": ("procedure", "procedure_id"),
        "event_frame": ("event_frame", "event_frame_id"),
        "working_memory": ("working_memory", "working_memory_id"),
    }
    table, id_column = table_by_kind[target_kind]
    cur.execute(
        f"""
        SELECT 1
        FROM preserve.{table}
        WHERE tenant = %s
          AND {id_column} = %s
        LIMIT 1
        """,
        [TENANT, target_id],
    )
    if cur.fetchone() is None:
        raise ValueError(f"Lifecycle target not found: {target_kind}:{target_id}")


def _lifecycle_visible_sql(alias: str, kind: str, id_column: str) -> str:
    return f"""
      AND NOT EXISTS (
        SELECT 1
        FROM preserve.lifecycle_target_intelligence lti
        WHERE lti.tenant = {alias}.tenant
          AND lti.target_kind = '{kind}'
          AND lti.target_id = {alias}.{id_column}
          AND lti.lifecycle_status IN ('suppressed','retired')
      )
    """


def _lifecycle_procedure_visible_sql(alias: str = "p") -> str:
    return _lifecycle_visible_sql(alias, "procedure", "procedure_id")


def _is_lifecycle_intelligence_missing(exc: UndefinedTable) -> bool:
    return "lifecycle_target_intelligence" in str(exc)


def _filter_lifecycle_hidden(
    pool: ConnectionPool,
    merged: dict[str, "_ScoredCandidate"],
) -> None:
    ids_by_kind: dict[str, list[str]] = {}
    for object_id, scored in merged.items():
        kind = scored.candidate.object_type
        if kind in ("fact", "memory", "procedure", "event_frame", "working_memory"):
            ids_by_kind.setdefault(kind, []).append(object_id)
    if not ids_by_kind:
        return

    hidden: set[str] = set()
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                for kind, ids in ids_by_kind.items():
                    placeholders = ",".join(["%s"] * len(ids))
                    cur.execute(
                        f"""
                        SELECT target_id::text
                        FROM preserve.lifecycle_target_intelligence
                        WHERE tenant = %s
                          AND target_kind = %s
                          AND lifecycle_status IN ('suppressed','retired')
                          AND target_id::text IN ({placeholders})
                        """,
                        [TENANT, kind] + ids,
                    )
                    hidden.update(row["target_id"] for row in cur.fetchall())
    except UndefinedTable:
        return

    for object_id in hidden:
        merged.pop(object_id, None)


def _plan_query(query: str, scope: Optional[str]) -> _QueryPlan:
    """Build a deterministic no-model query plan used only by optional reranking."""
    text = query.strip().lower()
    words = re.findall(r"[a-z0-9][a-z0-9_.:-]*", text)
    quoted = re.findall(r'"([^"]+)"', query)
    entities = _unique_ordered([
        token
        for token in words
        if len(token) >= 4 and token not in {
            "what", "when", "where", "which", "with", "from", "that",
            "this", "were", "was", "after", "before", "during", "issue",
            "incident", "memory", "search", "need", "does",
        }
    ] + quoted)

    scope_hints = []
    if scope:
        scope_hints.append(scope.lower())
    scope_hints.extend(token for token in words if ":" in token)

    predicate_hints = [
        kind
        for kind, hints in PREDICATE_HINTS.items()
        if any(hint in text for hint in hints)
    ]

    time_hints = re.findall(r"\b(?:20\d{2}-\d{2}-\d{2}|20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b", text)

    desired = "general"
    if "how" in words or "fix" in text or "remediat" in text:
        desired = "procedure"
    elif "when" in words or "timeline" in words or "before" in words or "after" in words:
        desired = "timeline"
    elif "why" in words or "cause" in predicate_hints:
        desired = "cause"
    elif "which" in words or "who" in words:
        desired = "entity"

    return _QueryPlan(
        entities=entities[:8],
        scope_hints=_unique_ordered(scope_hints)[:6],
        predicate_hints=tuple(predicate_hints),
        time_hints=tuple(time_hints[:4]),
        desired_answer_type=desired,
    )


def _candidate_text(candidate: _Candidate) -> str:
    return " ".join(
        part for part in [
            candidate.title or "",
            candidate.summary or "",
            candidate.scope_path or "",
            candidate.object_type,
        ] if part
    ).lower()


def _scope_match_score(candidate: _Candidate, plan: _QueryPlan) -> float:
    if not plan.scope_hints:
        return 0.0
    scope_path = (candidate.scope_path or "").lower()
    return 1.0 if any(scope_path.startswith(hint) for hint in plan.scope_hints) else 0.0


def _query_entity_match_score(candidate: _Candidate, plan: _QueryPlan) -> float:
    if not plan.entities:
        return 0.0
    text = _candidate_text(candidate)
    matches = sum(1 for entity in plan.entities if entity in text)
    return min(1.0, matches / max(1, min(len(plan.entities), 4)))


def _predicate_match_score(candidate: _Candidate, plan: _QueryPlan) -> float:
    if not plan.predicate_hints:
        return 0.0
    text = _candidate_text(candidate)
    matches = sum(1 for hint in plan.predicate_hints if hint in text)
    if "remediation" in plan.predicate_hints and ("fix" in text or "remediat" in text):
        matches += 1
    return min(1.0, matches / max(1, len(plan.predicate_hints)))


def _answer_type_score(candidate: _Candidate, plan: _QueryPlan) -> float:
    text = _candidate_text(candidate)
    if plan.desired_answer_type == "procedure":
        if candidate.object_type == "procedure":
            return 1.0
        return 1.0 if candidate.object_type == "memory" and ("playbook" in text or "fix" in text) else 0.0
    if plan.desired_answer_type == "timeline":
        return 1.0 if candidate.object_type == "episode" or candidate.valid_from else 0.0
    if plan.desired_answer_type == "cause":
        return 1.0 if "cause" in text or "why" in text else 0.0
    if plan.desired_answer_type == "entity":
        return 1.0 if candidate.object_type in ("fact", "episode") else 0.0
    return 0.0


def _temporal_hint_score(candidate: _Candidate, plan: _QueryPlan) -> float:
    if not plan.time_hints:
        return 0.0
    haystack = " ".join([candidate.valid_from or "", candidate.valid_to or "", candidate.summary or ""]).lower()
    return 1.0 if any(hint in haystack for hint in plan.time_hints) else 0.0


def _lightweight_rerank_score(scored: _ScoredCandidate, plan: _QueryPlan) -> float:
    """Feature-flagged deterministic score using only existing retrieval signals."""
    candidate = scored.candidate
    evidence_score = min(1.0, len(candidate.evidence) / 3.0)
    graph_score = min(1.0, scored.scores.get("graph", 0.0) * 100.0)
    confidence_score = candidate.confidence if candidate.confidence is not None else 0.5
    priority_score = scored.priority_boost / 2.0
    return (
        scored.total_score
        + 0.050 * _query_entity_match_score(candidate, plan)
        + 0.040 * _scope_match_score(candidate, plan)
        + 0.035 * _predicate_match_score(candidate, plan)
        + 0.030 * _answer_type_score(candidate, plan)
        + 0.025 * evidence_score
        + 0.020 * graph_score
        + 0.015 * _temporal_hint_score(candidate, plan)
        + 0.010 * confidence_score
        + 0.005 * priority_score
    )


def _rank_candidates(
    candidates: list[_ScoredCandidate],
    plan: _QueryPlan,
    reranking_enabled: bool,
) -> list[_ScoredCandidate]:
    if not reranking_enabled:
        return sorted(candidates, key=lambda sc: sc.total_score, reverse=True)
    return sorted(
        candidates,
        key=lambda sc: (_lightweight_rerank_score(sc, plan), sc.total_score),
        reverse=True,
    )


def _display_score(scored: _ScoredCandidate, plan: _QueryPlan, reranking_enabled: bool) -> float:
    if not reranking_enabled:
        return scored.total_score
    return _lightweight_rerank_score(scored, plan)


# ---------------------------------------------------------------------------
# Internal candidate model
# ---------------------------------------------------------------------------

@dataclass
class _Candidate:
    object_id: str
    object_type: str  # fact, memory, segment, episode, procedure, media_artifact, visual_region
    title: Optional[str] = None
    summary: Optional[str] = None
    confidence: Optional[float] = None
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    scope_path: Optional[str] = None
    priority: Optional[int] = None
    evidence: list[dict] = field(default_factory=list)
    why: list[dict] = field(default_factory=list)


@dataclass
class _ScoredCandidate:
    candidate: _Candidate
    scores: dict = field(default_factory=dict)  # stream_name -> rrf_score

    @property
    def raw_score(self) -> float:
        """Sum of RRF contributions across all streams (pre-boost)."""
        return sum(self.scores.values())

    @property
    def priority_boost(self) -> float:
        """Priority multiplier: 1 -> 2.0x, 5 -> 1.0x, 10 -> 0.2x.
        Objects with no priority (segment/episode) get the neutral 1.0x."""
        p = self.candidate.priority
        if p is None:
            return 1.0
        return (11 - p) / 5.0

    @property
    def total_score(self) -> float:
        return self.raw_score * self.priority_boost


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts_str(val) -> Optional[str]:
    """Convert a datetime/date to ISO string, or None."""
    if val is None:
        return None
    return str(val)


def _task_session_from_row(row) -> dict:
    return {
        "session_id": row["session_id"],
        "session_key": row["session_key"],
        "agent_name": row["agent_name"],
        "task_title": row.get("task_title"),
        "status": row["status"],
        "scope_path": row.get("scope_path"),
        "started_at": _ts_str(row["started_at"]),
        "last_seen_at": _ts_str(row["last_seen_at"]),
        "ended_at": _ts_str(row.get("ended_at")),
        "expires_at": _ts_str(row.get("expires_at")),
    }


def _working_memory_from_row(row) -> dict:
    return {
        "working_memory_id": row["working_memory_id"],
        "session_id": row["session_id"],
        "session_key": row.get("session_key"),
        "memory_kind": row["memory_kind"],
        "content": row["content"],
        "promotion_status": row["promotion_status"],
        "promotion_reason": row.get("promotion_reason"),
        "promotion_target_kind": row.get("promotion_target_kind"),
        "promotion_target_id": row.get("promotion_target_id"),
        "expires_at": _ts_str(row["expires_at"]),
        "created_at": _ts_str(row["created_at"]),
    }


def _visual_result_from_row(row) -> dict:
    bbox = None
    if row.get("x_min") is not None:
        bbox = {
            "x_min": float(row["x_min"]),
            "y_min": float(row["y_min"]),
            "x_max": float(row["x_max"]),
            "y_max": float(row["y_max"]),
        }
    return {
        "result_type": row["result_type"],
        "media_artifact_id": row["media_artifact_id"],
        "visual_region_id": row.get("visual_region_id"),
        "media_type": row["media_type"],
        "mime_type": row.get("mime_type"),
        "scope_path": row.get("scope_path"),
        "page_number": row.get("page_number"),
        "region_type": row.get("region_type"),
        "label": row.get("label"),
        "text": row.get("text"),
        "artifact_id": row.get("artifact_id"),
        "source_segment_id": row.get("source_segment_id"),
        "linked_entity_id": row.get("linked_entity_id"),
        "linked_fact_id": row.get("linked_fact_id"),
        "linked_memory_id": row.get("linked_memory_id"),
        "linked_procedure_id": row.get("linked_procedure_id"),
        "bbox": bbox,
        "confidence": row.get("confidence"),
        "ingest_run_id": row.get("ingest_run_id"),
        "ingest_batch_key": row.get("ingest_batch_key"),
    }


def _procedure_operational_step_from_row(row) -> dict:
    return {
        "procedure_id": row["procedure_id"],
        "procedure_title": row["procedure_title"],
        "procedure_summary": row.get("procedure_summary"),
        "scope_path": row.get("scope_path"),
        "procedure_source_fact_id": row.get("procedure_source_fact_id"),
        "procedure_evidence_segment_id": row.get("procedure_evidence_segment_id"),
        "episode_outcome": row.get("episode_outcome"),
        "step_id": row["step_id"],
        "step_index": row["step_index"],
        "action": row["action"],
        "expected_result": row.get("expected_result"),
        "step_source_fact_id": row.get("step_source_fact_id"),
        "step_evidence_segment_id": row.get("step_evidence_segment_id"),
        "confidence": row.get("confidence"),
    }


def _as_of_clause(as_of: Optional[str], prefix: str = "") -> tuple[str, list]:
    """Build temporal validity filter clause + params.

    Returns (sql_fragment, params).
    prefix should be like 'f.' for fact table alias.
    """
    if as_of is None:
        return "", []
    col_from = f"{prefix}valid_from"
    col_to = f"{prefix}valid_to"
    clause = (
        f" AND ({col_from} IS NULL OR {col_from} <= %s::timestamptz)"
        f" AND ({col_to} IS NULL OR {col_to} > %s::timestamptz)"
    )
    return clause, [as_of, as_of]


def _scope_clause(scope: Optional[str], prefix: str = "") -> tuple[str, list]:
    """Build scope_path LIKE filter."""
    if scope is None:
        return "", []
    col = f"{prefix}scope_path"
    return f" AND {col} LIKE %s", [scope + "%"]


def _tenant_clause(tenant: str, prefix: str = "") -> tuple[str, list]:
    """Build exact tenant filter for the current process tenant."""
    col = f"{prefix}tenant"
    return f" AND {col} = %s", [tenant]


def _vec_literal(arr) -> str:
    """Convert numpy array to pgvector literal."""
    return "[" + ",".join(f"{x:.8f}" for x in arr) + "]"


def _timeline_subject_clause(subject: Optional[str]) -> tuple[str, list]:
    """Build an actor/target/location entity name filter."""
    if subject is None:
        return "", []
    clause = """
        AND (
            actor.canonical_name ILIKE %s
            OR target.canonical_name ILIKE %s
            OR location.canonical_name ILIKE %s
        )
    """
    pattern = f"%{subject}%"
    return clause, [pattern, pattern, pattern]


def _timeline_time_clause(
    from_ts: Optional[str],
    to_ts: Optional[str],
) -> tuple[str, list]:
    """Build timeline bounds over frame time_start."""
    clauses: list[str] = []
    params: list = []
    if from_ts is not None:
        clauses.append("AND ef.time_start >= %s::timestamptz")
        params.append(from_ts)
    if to_ts is not None:
        clauses.append("AND ef.time_start < %s::timestamptz")
        params.append(to_ts)
    return "\n".join(clauses), params


def _event_frame_select_sql(include_evidence: bool) -> tuple[str, str]:
    """Return SELECT evidence columns and optional evidence join."""
    evidence_select = """
        fe.excerpt AS evidence_excerpt,
        fe.source_relpath AS evidence_source_relpath,
        fe.line_start AS evidence_line_start,
        fe.line_end AS evidence_line_end
    """ if include_evidence else """
        NULL::text AS evidence_excerpt,
        NULL::text AS evidence_source_relpath,
        NULL::integer AS evidence_line_start,
        NULL::integer AS evidence_line_end
    """

    evidence_join = """
        LEFT JOIN preserve.fact_evidence fe
          ON fe.fact_id = ef.source_fact_id
         AND fe.segment_id = ef.evidence_segment_id
    """ if include_evidence else ""
    return evidence_select, evidence_join


def _timeline_entries_from_rows(rows, include_evidence: bool) -> list[dict]:
    """Convert event_frame SQL rows into TimelineEntry-compatible dicts."""
    entries = []
    for row in rows:
        evidence = []
        if include_evidence and row.get("evidence_segment_id"):
            evidence.append({
                "segment_id": row.get("evidence_segment_id"),
                "excerpt": row.get("evidence_excerpt"),
                "source_relpath": row.get("evidence_source_relpath"),
                "line_start": row.get("evidence_line_start"),
                "line_end": row.get("evidence_line_end"),
            })
        entries.append({
            "timestamp": _ts_str(row["time_start"]),
            "time_end": _ts_str(row["time_end"]),
            "event_frame_id": row["event_frame_id"],
            "episode_id": row["episode_id"],
            "source_fact_id": row["source_fact_id"],
            "event_type": row["event_type"],
            "actor": row["actor"],
            "action": row["action"],
            "target": row["target"],
            "location": row["location"],
            "object_value": row["object_value"],
            "outcome": row["outcome"],
            "confidence": row["confidence"],
            "assertion_class": row["assertion_class"],
            "scope_path": row["scope_path"],
            "evidence": evidence,
        })
    return entries


# ---------------------------------------------------------------------------
# Stream 1: Structured SQL — entity name match -> facts
# ---------------------------------------------------------------------------

def _stream_structured(
    pool: ConnectionPool,
    query: str,
    as_of: Optional[str],
    scope: Optional[str],
    type_filter: Optional[str],
    limit: int,
) -> list[_Candidate]:
    """Match entity names, then return facts where that entity is subject."""
    if type_filter and type_filter not in ("fact", None):
        return []  # structured only yields facts

    as_of_sql, as_of_params = _as_of_clause(as_of, "f.")
    scope_sql, scope_params = _scope_clause(scope, "f.")
    tenant_sql, tenant_params = _tenant_clause(TENANT, "f.")

    # Search for entity by canonical_name or alias match
    sql = f"""
        WITH matched_entities AS (
            SELECT entity_id, canonical_name
            FROM preserve.entity e
            WHERE e.tenant = %s
              AND (
                e.canonical_name ILIKE %s
                OR e.aliases::text ILIKE %s
              )
            LIMIT 20
        )
        SELECT
            f.fact_id::text AS object_id,
            'fact' AS object_type,
            (e_sub.canonical_name || ' ' || f.predicate) AS title,
            COALESCE(f.object_value::text, e_obj.canonical_name, '') AS summary,
            f.confidence::float,
            f.valid_from,
            f.valid_to,
            f.scope_path,
            f.priority
        FROM preserve.fact f
        JOIN matched_entities me ON f.subject_entity_id = me.entity_id
        JOIN preserve.entity e_sub ON f.subject_entity_id = e_sub.entity_id
        LEFT JOIN preserve.entity e_obj ON f.object_entity_id = e_obj.entity_id
        WHERE f.current_status = 'active'
            {as_of_sql}
            {scope_sql}
            {tenant_sql}
        ORDER BY f.confidence DESC, f.last_seen_at DESC NULLS LAST
        LIMIT %s
    """

    like_pattern = f"%{query}%"
    params = (
        [TENANT, like_pattern, like_pattern]
        + as_of_params
        + scope_params
        + tenant_params
        + [limit * 3]
    )

    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

    return [
        _Candidate(
            object_id=r["object_id"],
            object_type=r["object_type"],
            title=r["title"],
            summary=r["summary"],
            confidence=float(r["confidence"]) if r["confidence"] is not None else None,
            valid_from=_ts_str(r["valid_from"]),
            valid_to=_ts_str(r["valid_to"]),
            scope_path=r["scope_path"],
            priority=r.get("priority"),
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Stream 2: Full-text search across preserve tables
# ---------------------------------------------------------------------------

def _stream_fts(
    pool: ConnectionPool,
    query: str,
    as_of: Optional[str],
    scope: Optional[str],
    type_filter: Optional[str],
    limit: int,
) -> list[_Candidate]:
    """FTS across fact, memory, segment, episode using plainto_tsquery."""
    candidates: list[_Candidate] = []
    sub_limit = limit * 3

    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            # -- fact FTS --
            if type_filter in (None, "fact"):
                as_of_sql, as_of_params = _as_of_clause(as_of, "f.")
                scope_sql, scope_params = _scope_clause(scope, "f.")
                tenant_sql, tenant_params = _tenant_clause(TENANT, "f.")
                sql = f"""
                    SELECT
                        f.fact_id::text AS object_id,
                        'fact' AS object_type,
                        f.predicate AS title,
                        COALESCE(f.object_value::text, '') AS summary,
                        f.confidence::float,
                        f.valid_from, f.valid_to, f.scope_path,
                        f.priority,
                        ts_rank_cd(f.fts, plainto_tsquery('english', %s)) AS rank
                    FROM preserve.fact f
                    WHERE f.fts @@ plainto_tsquery('english', %s)
                      AND f.current_status = 'active'
                      {as_of_sql}
                      {scope_sql}
                      {tenant_sql}
                    ORDER BY rank DESC
                    LIMIT %s
                """
                params = (
                    [query, query]
                    + as_of_params
                    + scope_params
                    + tenant_params
                    + [sub_limit]
                )
                cur.execute(sql, params)
                for r in cur.fetchall():
                    candidates.append(_Candidate(
                        object_id=r["object_id"], object_type="fact",
                        title=r["title"], summary=r["summary"],
                        confidence=float(r["confidence"]) if r["confidence"] is not None else None,
                        valid_from=_ts_str(r["valid_from"]),
                        valid_to=_ts_str(r["valid_to"]),
                        scope_path=r["scope_path"],
                        priority=r.get("priority"),
                    ))

            # -- memory FTS --
            if type_filter in (None, "memory"):
                as_of_sql, as_of_params = _as_of_clause(as_of, "m.")
                scope_sql, scope_params = _scope_clause(scope, "m.")
                tenant_sql, tenant_params = _tenant_clause(TENANT, "m.")
                sql = f"""
                    SELECT
                        m.memory_id::text AS object_id,
                        'memory' AS object_type,
                        m.title,
                        m.narrative AS summary,
                        m.confidence::float,
                        m.valid_from, m.valid_to, m.scope_path,
                        m.priority,
                        ts_rank_cd(m.fts, plainto_tsquery('english', %s)) AS rank
                    FROM preserve.memory m
                    WHERE m.fts @@ plainto_tsquery('english', %s)
                      {as_of_sql}
                      {scope_sql}
                      {tenant_sql}
                    ORDER BY rank DESC
                    LIMIT %s
                """
                params = (
                    [query, query]
                    + as_of_params
                    + scope_params
                    + tenant_params
                    + [sub_limit]
                )
                cur.execute(sql, params)
                for r in cur.fetchall():
                    candidates.append(_Candidate(
                        object_id=r["object_id"], object_type="memory",
                        title=r["title"], summary=r["summary"],
                        confidence=float(r["confidence"]) if r["confidence"] is not None else None,
                        valid_from=_ts_str(r["valid_from"]),
                        valid_to=_ts_str(r["valid_to"]),
                        scope_path=r["scope_path"],
                        priority=r.get("priority"),
                    ))

            # -- segment FTS --
            if type_filter in (None, "segment"):
                scope_sql, scope_params = _scope_clause(scope, "s.")
                tenant_sql, tenant_params = _tenant_clause(TENANT, "s.")
                sql = f"""
                    SELECT
                        s.segment_id::text AS object_id,
                        'segment' AS object_type,
                        s.section_label AS title,
                        LEFT(s.content, 500) AS summary,
                        NULL::float AS confidence,
                        NULL AS valid_from, NULL AS valid_to, s.scope_path,
                        NULL::int AS priority,
                        ts_rank_cd(s.fts, plainto_tsquery('english', %s)) AS rank
                    FROM preserve.segment s
                    WHERE s.fts @@ plainto_tsquery('english', %s)
                      {scope_sql}
                      {tenant_sql}
                    ORDER BY rank DESC
                    LIMIT %s
                """
                params = (
                    [query, query]
                    + scope_params
                    + tenant_params
                    + [sub_limit]
                )
                cur.execute(sql, params)
                for r in cur.fetchall():
                    candidates.append(_Candidate(
                        object_id=r["object_id"], object_type="segment",
                        title=r["title"], summary=r["summary"],
                        confidence=None,
                        valid_from=None, valid_to=None,
                        scope_path=r["scope_path"],
                        priority=r.get("priority"),
                    ))

            # -- episode FTS --
            if type_filter in (None, "episode"):
                scope_sql, scope_params = _scope_clause(scope, "ep.")
                tenant_sql, tenant_params = _tenant_clause(TENANT, "ep.")
                sql = f"""
                    SELECT
                        ep.episode_id::text AS object_id,
                        'episode' AS object_type,
                        ep.title,
                        ep.summary,
                        NULL::float AS confidence,
                        ep.start_at AS valid_from, ep.end_at AS valid_to,
                        ep.scope_path,
                        NULL::int AS priority,
                        ts_rank_cd(ep.fts, plainto_tsquery('english', %s)) AS rank
                    FROM preserve.episode ep
                    WHERE ep.fts @@ plainto_tsquery('english', %s)
                      {scope_sql}
                      {tenant_sql}
                    ORDER BY rank DESC
                    LIMIT %s
                """
                params = (
                    [query, query]
                    + scope_params
                    + tenant_params
                    + [sub_limit]
                )
                cur.execute(sql, params)
                for r in cur.fetchall():
                    candidates.append(_Candidate(
                        object_id=r["object_id"], object_type="episode",
                        title=r["title"], summary=r["summary"],
                        confidence=None,
                        valid_from=_ts_str(r["valid_from"]),
                        valid_to=_ts_str(r["valid_to"]),
                        scope_path=r["scope_path"],
                        priority=r.get("priority"),
                    ))

    return candidates


# ---------------------------------------------------------------------------
# Stream 3: Vector search
# ---------------------------------------------------------------------------

def _stream_embedding_index_vector(
    pool: ConnectionPool,
    query: str,
    as_of: Optional[str],
    scope: Optional[str],
    type_filter: Optional[str],
    limit: int,
) -> list[_Candidate]:
    """Embed query, then search role-specific preserve.embedding_index rows.

    This is feature-flagged by ``BRAINCORE_EMBEDDING_INDEX_RETRIEVAL`` so the
    legacy table-column vector stream remains the default fallback.
    """
    embedding = embed_query(query)
    emb_str = _vec_literal(embedding)
    sub_limit = limit * 3
    candidates: list[_Candidate] = []

    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                if type_filter in (None, "fact"):
                    as_of_sql, as_of_params = _as_of_clause(as_of, "f.")
                    scope_sql, scope_params = _scope_clause(scope, "f.")
                    tenant_sql, tenant_params = _tenant_clause(TENANT, "f.")
                    sql = f"""
                        SELECT
                            f.fact_id::text AS object_id,
                            'fact' AS object_type,
                            f.predicate AS title,
                            COALESCE(f.object_value::text, '') AS summary,
                            f.confidence::float,
                            f.valid_from, f.valid_to, f.scope_path,
                            f.priority,
                            1 - (ei.embedding <=> %s::vector) AS cosine_sim
                        FROM preserve.embedding_index ei
                        JOIN preserve.fact f
                          ON f.tenant = ei.tenant
                         AND f.fact_id = ei.fact_id
                        WHERE ei.tenant = %s
                          AND ei.vector_role = 'evidence'
                          AND ei.target_kind = 'fact'
                          AND f.current_status = 'active'
                          {as_of_sql}
                          {scope_sql}
                          {tenant_sql}
                        ORDER BY ei.embedding <=> %s::vector
                        LIMIT %s
                    """
                    params = (
                        [emb_str, TENANT]
                        + as_of_params
                        + scope_params
                        + tenant_params
                        + [emb_str, sub_limit]
                    )
                    cur.execute(sql, params)
                    for r in cur.fetchall():
                        candidates.append(_Candidate(
                            object_id=r["object_id"], object_type="fact",
                            title=r["title"], summary=r["summary"],
                            confidence=float(r["confidence"]) if r["confidence"] is not None else None,
                            valid_from=_ts_str(r["valid_from"]),
                            valid_to=_ts_str(r["valid_to"]),
                            scope_path=r["scope_path"],
                            priority=r.get("priority"),
                        ))

                if type_filter in (None, "segment"):
                    scope_sql, scope_params = _scope_clause(scope, "s.")
                    tenant_sql, tenant_params = _tenant_clause(TENANT, "s.")
                    sql = f"""
                        SELECT
                            s.segment_id::text AS object_id,
                            'segment' AS object_type,
                            s.section_label AS title,
                            LEFT(s.content, 500) AS summary,
                            NULL::float AS confidence,
                            NULL AS valid_from, NULL AS valid_to, s.scope_path,
                            NULL::int AS priority,
                            1 - (ei.embedding <=> %s::vector) AS cosine_sim
                        FROM preserve.embedding_index ei
                        JOIN preserve.segment s
                          ON s.tenant = ei.tenant
                         AND s.segment_id = ei.segment_id
                        WHERE ei.tenant = %s
                          AND ei.vector_role = 'text'
                          AND ei.target_kind = 'segment'
                          {scope_sql}
                          {tenant_sql}
                        ORDER BY ei.embedding <=> %s::vector
                        LIMIT %s
                    """
                    params = (
                        [emb_str, TENANT]
                        + scope_params
                        + tenant_params
                        + [emb_str, sub_limit]
                    )
                    cur.execute(sql, params)
                    for r in cur.fetchall():
                        candidates.append(_Candidate(
                            object_id=r["object_id"], object_type="segment",
                            title=r["title"], summary=r["summary"],
                            confidence=None,
                            valid_from=None, valid_to=None,
                            scope_path=r["scope_path"],
                            priority=r.get("priority"),
                        ))

                if type_filter in (None, "procedure"):
                    scope_sql, scope_params = _scope_clause(scope, "p.")
                    tenant_sql, tenant_params = _tenant_clause(TENANT, "p.")
                    sql = f"""
                        SELECT
                            p.procedure_id::text AS object_id,
                            'procedure' AS object_type,
                            p.title,
                            p.summary,
                            p.confidence::float,
                            NULL AS valid_from,
                            NULL AS valid_to,
                            p.scope_path,
                            NULL::int AS priority,
                            1 - (ei.embedding <=> %s::vector) AS cosine_sim
                        FROM preserve.embedding_index ei
                        JOIN preserve.procedure p
                          ON p.tenant = ei.tenant
                         AND p.procedure_id = ei.procedure_id
                        WHERE ei.tenant = %s
                          AND ei.vector_role = 'procedure'
                          AND ei.target_kind = 'procedure'
                          AND p.lifecycle_state != 'retired'::preserve.lifecycle_state
                          {_lifecycle_procedure_visible_sql("p")}
                          {scope_sql}
                          {tenant_sql}
                        ORDER BY ei.embedding <=> %s::vector
                        LIMIT %s
                    """
                    params = (
                        [emb_str, TENANT]
                        + scope_params
                        + tenant_params
                        + [emb_str, sub_limit]
                    )
                    cur.execute(sql, params)
                    for r in cur.fetchall():
                        candidates.append(_Candidate(
                            object_id=r["object_id"], object_type="procedure",
                            title=r["title"], summary=r["summary"],
                            confidence=float(r["confidence"]) if r["confidence"] is not None else None,
                            valid_from=None, valid_to=None,
                            scope_path=r["scope_path"],
                            priority=r.get("priority"),
                        ))

                if type_filter in (None, "media_artifact"):
                    scope_sql, scope_params = _scope_clause(scope, "ma.")
                    tenant_sql, tenant_params = _tenant_clause(TENANT, "ma.")
                    sql = f"""
                        SELECT
                            ma.media_artifact_id::text AS object_id,
                            'media_artifact' AS object_type,
                            COALESCE(
                              ma.media_meta->>'title',
                              ma.media_meta->>'caption',
                              ma.media_meta->>'description',
                              ma.media_type
                            ) AS title,
                            COALESCE(
                              ma.media_meta->>'caption',
                              ma.media_meta->>'description',
                              ma.media_meta->>'alt_text',
                              ma.media_meta->>'title',
                              ''
                            ) AS summary,
                            NULL::float AS confidence,
                            NULL AS valid_from,
                            NULL AS valid_to,
                            ma.scope_path,
                            NULL::int AS priority,
                            1 - (ei.embedding <=> %s::vector) AS cosine_sim
                        FROM preserve.embedding_index ei
                        JOIN preserve.media_artifact ma
                          ON ma.tenant = ei.tenant
                         AND ma.media_artifact_id = ei.media_artifact_id
                        WHERE ei.tenant = %s
                          AND ei.vector_role = 'media_caption'
                          AND ei.target_kind = 'media_artifact'
                          {scope_sql}
                          {tenant_sql}
                        ORDER BY ei.embedding <=> %s::vector
                        LIMIT %s
                    """
                    params = (
                        [emb_str, TENANT]
                        + scope_params
                        + tenant_params
                        + [emb_str, sub_limit]
                    )
                    cur.execute(sql, params)
                    for r in cur.fetchall():
                        candidates.append(_Candidate(
                            object_id=r["object_id"], object_type="media_artifact",
                            title=r["title"], summary=r["summary"],
                            confidence=None,
                            valid_from=None, valid_to=None,
                            scope_path=r["scope_path"],
                            priority=r.get("priority"),
                        ))

                if type_filter in (None, "visual_region"):
                    # _scope_clause() is not used here because visual scope may
                    # live either on region metadata or the parent media row.
                    scope_sql = " AND COALESCE(vr.region_meta->>'scope_path', ma.scope_path, '') LIKE %s" if scope else ""
                    scope_params = [scope + "%"] if scope else []
                    tenant_sql, tenant_params = _tenant_clause(TENANT, "vr.")
                    sql = f"""
                        SELECT
                            vr.visual_region_id::text AS object_id,
                            'visual_region' AS object_type,
                            COALESCE(vr.label, vr.region_type) AS title,
                            COALESCE(
                              vr.region_meta->>'ocr_text',
                              vr.region_meta->>'text',
                              vr.region_meta->>'caption',
                              vr.label,
                              ''
                            ) AS summary,
                            vr.confidence::float,
                            NULL AS valid_from,
                            NULL AS valid_to,
                            COALESCE(vr.region_meta->>'scope_path', ma.scope_path) AS scope_path,
                            NULL::int AS priority,
                            1 - (ei.embedding <=> %s::vector) AS cosine_sim
                        FROM preserve.embedding_index ei
                        JOIN preserve.visual_region vr
                          ON vr.tenant = ei.tenant
                         AND vr.visual_region_id = ei.visual_region_id
                        JOIN preserve.media_artifact ma
                          ON ma.tenant = vr.tenant
                         AND ma.media_artifact_id = vr.media_artifact_id
                        WHERE ei.tenant = %s
                          AND ei.vector_role IN ('visual_ocr', 'visual_caption')
                          AND ei.target_kind = 'visual_region'
                          {scope_sql}
                          {tenant_sql}
                        ORDER BY ei.embedding <=> %s::vector
                        LIMIT %s
                    """
                    params = (
                        [emb_str, TENANT]
                        + scope_params
                        + tenant_params
                        + [emb_str, sub_limit]
                    )
                    cur.execute(sql, params)
                    for r in cur.fetchall():
                        candidates.append(_Candidate(
                            object_id=r["object_id"], object_type="visual_region",
                            title=r["title"], summary=r["summary"],
                            confidence=float(r["confidence"]) if r["confidence"] is not None else None,
                            valid_from=None, valid_to=None,
                            scope_path=r["scope_path"],
                            priority=r.get("priority"),
                        ))
    except UndefinedTable:
        return []

    return candidates


def _stream_vector(
    pool: ConnectionPool,
    query: str,
    as_of: Optional[str],
    scope: Optional[str],
    type_filter: Optional[str],
    limit: int,
) -> list[_Candidate]:
    """Embed query, then cosine-similarity search across all 4 tables."""
    if EMBEDDING_INDEX_RETRIEVAL_ENABLED:
        # Embedding-index retrieval currently covers fact evidence and segment text only.
        # Memory/episode type filters intentionally return no vector candidates until
        # dedicated embedding_index roles are added for those result types.
        return _stream_embedding_index_vector(pool, query, as_of, scope, type_filter, limit)

    embedding = embed_query(query)
    emb_str = _vec_literal(embedding)
    sub_limit = limit * 3
    candidates: list[_Candidate] = []

    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            # -- fact vector --
            if type_filter in (None, "fact"):
                as_of_sql, as_of_params = _as_of_clause(as_of, "f.")
                scope_sql, scope_params = _scope_clause(scope, "f.")
                tenant_sql, tenant_params = _tenant_clause(TENANT, "f.")
                sql = f"""
                    SELECT
                        f.fact_id::text AS object_id,
                        'fact' AS object_type,
                        f.predicate AS title,
                        COALESCE(f.object_value::text, '') AS summary,
                        f.confidence::float,
                        f.valid_from, f.valid_to, f.scope_path,
                        f.priority,
                        1 - (f.embedding <=> %s::vector) AS cosine_sim
                    FROM preserve.fact f
                    WHERE f.embedding IS NOT NULL
                      AND f.current_status = 'active'
                      {as_of_sql}
                      {scope_sql}
                      {tenant_sql}
                    ORDER BY f.embedding <=> %s::vector
                    LIMIT %s
                """
                params = (
                    [emb_str]
                    + as_of_params
                    + scope_params
                    + tenant_params
                    + [emb_str, sub_limit]
                )
                cur.execute(sql, params)
                for r in cur.fetchall():
                    candidates.append(_Candidate(
                        object_id=r["object_id"], object_type="fact",
                        title=r["title"], summary=r["summary"],
                        confidence=float(r["confidence"]) if r["confidence"] is not None else None,
                        valid_from=_ts_str(r["valid_from"]),
                        valid_to=_ts_str(r["valid_to"]),
                        scope_path=r["scope_path"],
                        priority=r.get("priority"),
                    ))

            # -- memory vector --
            if type_filter in (None, "memory"):
                as_of_sql, as_of_params = _as_of_clause(as_of, "m.")
                scope_sql, scope_params = _scope_clause(scope, "m.")
                tenant_sql, tenant_params = _tenant_clause(TENANT, "m.")
                sql = f"""
                    SELECT
                        m.memory_id::text AS object_id,
                        'memory' AS object_type,
                        m.title,
                        m.narrative AS summary,
                        m.confidence::float,
                        m.valid_from, m.valid_to, m.scope_path,
                        m.priority,
                        1 - (m.embedding <=> %s::vector) AS cosine_sim
                    FROM preserve.memory m
                    WHERE m.embedding IS NOT NULL
                      {as_of_sql}
                      {scope_sql}
                      {tenant_sql}
                    ORDER BY m.embedding <=> %s::vector
                    LIMIT %s
                """
                params = (
                    [emb_str]
                    + as_of_params
                    + scope_params
                    + tenant_params
                    + [emb_str, sub_limit]
                )
                cur.execute(sql, params)
                for r in cur.fetchall():
                    candidates.append(_Candidate(
                        object_id=r["object_id"], object_type="memory",
                        title=r["title"], summary=r["summary"],
                        confidence=float(r["confidence"]) if r["confidence"] is not None else None,
                        valid_from=_ts_str(r["valid_from"]),
                        valid_to=_ts_str(r["valid_to"]),
                        scope_path=r["scope_path"],
                        priority=r.get("priority"),
                    ))

            # -- segment vector --
            if type_filter in (None, "segment"):
                scope_sql, scope_params = _scope_clause(scope, "s.")
                tenant_sql, tenant_params = _tenant_clause(TENANT, "s.")
                sql = f"""
                    SELECT
                        s.segment_id::text AS object_id,
                        'segment' AS object_type,
                        s.section_label AS title,
                        LEFT(s.content, 500) AS summary,
                        NULL::float AS confidence,
                        NULL AS valid_from, NULL AS valid_to, s.scope_path,
                        NULL::int AS priority,
                        1 - (s.embedding <=> %s::vector) AS cosine_sim
                    FROM preserve.segment s
                    WHERE s.embedding IS NOT NULL
                      {scope_sql}
                      {tenant_sql}
                    ORDER BY s.embedding <=> %s::vector
                    LIMIT %s
                """
                params = (
                    [emb_str]
                    + scope_params
                    + tenant_params
                    + [emb_str, sub_limit]
                )
                cur.execute(sql, params)
                for r in cur.fetchall():
                    candidates.append(_Candidate(
                        object_id=r["object_id"], object_type="segment",
                        title=r["title"], summary=r["summary"],
                        confidence=None,
                        valid_from=None, valid_to=None,
                        scope_path=r["scope_path"],
                        priority=r.get("priority"),
                    ))

            # -- episode vector --
            if type_filter in (None, "episode"):
                scope_sql, scope_params = _scope_clause(scope, "ep.")
                tenant_sql, tenant_params = _tenant_clause(TENANT, "ep.")
                sql = f"""
                    SELECT
                        ep.episode_id::text AS object_id,
                        'episode' AS object_type,
                        ep.title,
                        ep.summary,
                        NULL::float AS confidence,
                        ep.start_at AS valid_from, ep.end_at AS valid_to,
                        ep.scope_path,
                        NULL::int AS priority,
                        1 - (ep.embedding <=> %s::vector) AS cosine_sim
                    FROM preserve.episode ep
                    WHERE ep.embedding IS NOT NULL
                      {scope_sql}
                      {tenant_sql}
                    ORDER BY ep.embedding <=> %s::vector
                    LIMIT %s
                """
                params = (
                    [emb_str]
                    + scope_params
                    + tenant_params
                    + [emb_str, sub_limit]
                )
                cur.execute(sql, params)
                for r in cur.fetchall():
                    candidates.append(_Candidate(
                        object_id=r["object_id"], object_type="episode",
                        title=r["title"], summary=r["summary"],
                        confidence=None,
                        valid_from=_ts_str(r["valid_from"]),
                        valid_to=_ts_str(r["valid_to"]),
                        scope_path=r["scope_path"],
                        priority=r.get("priority"),
                    ))

    return candidates


# ---------------------------------------------------------------------------
# Stream 4: Temporal / Relation expansion (enrichment)
# ---------------------------------------------------------------------------

def _stream_temporal_expand(
    pool: ConnectionPool,
    seen_candidates: dict[str, _ScoredCandidate],
    as_of: Optional[str],
    scope: Optional[str],
    limit: int,
) -> list[_Candidate]:
    """Given entities from streams 1-3, expand via fact relations and
    episode membership.  This is enrichment — not independent candidates."""
    # Collect entity IDs from fact candidates
    fact_ids = [
        cid for cid, sc in seen_candidates.items()
        if sc.candidate.object_type == "fact"
    ]
    episode_ids = [
        cid for cid, sc in seen_candidates.items()
        if sc.candidate.object_type == "episode"
    ]

    if not fact_ids and not episode_ids:
        return []

    candidates: list[_Candidate] = []
    as_of_sql, as_of_params = _as_of_clause(as_of, "f2.")
    scope_sql, scope_params = _scope_clause(scope, "f2.")
    tenant_sql, tenant_params = _tenant_clause(TENANT, "f2.")

    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            # Expand: for facts we already found, find related facts
            # via shared subject_entity_id
            if fact_ids:
                placeholders = ",".join(["%s"] * len(fact_ids))
                sql = f"""
                    SELECT DISTINCT
                        f2.fact_id::text AS object_id,
                        'fact' AS object_type,
                        f2.predicate AS title,
                        COALESCE(f2.object_value::text, '') AS summary,
                        f2.confidence::float,
                        f2.valid_from, f2.valid_to, f2.scope_path,
                        f2.priority
                    FROM preserve.fact f1
                    JOIN preserve.fact f2
                        ON f2.subject_entity_id = f1.subject_entity_id
                        AND f2.fact_id != f1.fact_id
                    WHERE f1.fact_id::text IN ({placeholders})
                      AND f2.current_status = 'active'
                      {as_of_sql}
                      {scope_sql}
                      {tenant_sql}
                    LIMIT %s
                """
                params = (
                    fact_ids
                    + as_of_params
                    + scope_params
                    + tenant_params
                    + [limit * 2]
                )
                cur.execute(sql, params)
                for r in cur.fetchall():
                    if r["object_id"] not in seen_candidates:
                        candidates.append(_Candidate(
                            object_id=r["object_id"], object_type="fact",
                            title=r["title"], summary=r["summary"],
                            confidence=float(r["confidence"]) if r["confidence"] is not None else None,
                            valid_from=_ts_str(r["valid_from"]),
                            valid_to=_ts_str(r["valid_to"]),
                            scope_path=r["scope_path"],
                            priority=r.get("priority"),
                        ))

            # Expand: for episodes found, find associated facts
            if episode_ids:
                placeholders = ",".join(["%s"] * len(episode_ids))
                as_of_sql2, as_of_params2 = _as_of_clause(as_of, "f.")
                scope_sql2, scope_params2 = _scope_clause(scope, "f.")
                tenant_sql2, tenant_params2 = _tenant_clause(TENANT, "f.")
                sql = f"""
                    SELECT
                        f.fact_id::text AS object_id,
                        'fact' AS object_type,
                        f.predicate AS title,
                        COALESCE(f.object_value::text, '') AS summary,
                        f.confidence::float,
                        f.valid_from, f.valid_to, f.scope_path,
                        f.priority
                    FROM preserve.fact f
                    WHERE f.episode_id::text IN ({placeholders})
                      AND f.current_status = 'active'
                      {as_of_sql2}
                      {scope_sql2}
                      {tenant_sql2}
                    LIMIT %s
                """
                params = (
                    episode_ids
                    + as_of_params2
                    + scope_params2
                    + tenant_params2
                    + [limit * 2]
                )
                cur.execute(sql, params)
                for r in cur.fetchall():
                    if r["object_id"] not in seen_candidates:
                        candidates.append(_Candidate(
                            object_id=r["object_id"], object_type="fact",
                            title=r["title"], summary=r["summary"],
                            confidence=float(r["confidence"]) if r["confidence"] is not None else None,
                            valid_from=_ts_str(r["valid_from"]),
                            valid_to=_ts_str(r["valid_to"]),
                            scope_path=r["scope_path"],
                            priority=r.get("priority"),
                        ))

    return candidates


# ---------------------------------------------------------------------------
# Stream 5: Graph path retrieval (feature-flagged)
# ---------------------------------------------------------------------------

def _stream_graph_path(
    pool: ConnectionPool,
    seen_candidates: dict[str, _ScoredCandidate],
    as_of: Optional[str],
    scope: Optional[str],
    type_filter: Optional[str],
    limit: int,
) -> list[_Candidate]:
    """Expand from current seeds over typed memory_edge links."""
    if type_filter == "segment":
        return []

    seeds = [
        (sc.candidate.object_type, sc.candidate.object_id)
        for sc in seen_candidates.values()
        if sc.candidate.object_type in ("fact", "memory", "episode")
    ]
    if not seeds:
        return []

    selected_seeds = seeds[: limit * 3]
    seed_sql = ",".join(["(%s::text, %s::uuid)"] * len(selected_seeds))
    seed_params = [value for pair in selected_seeds for value in pair]
    as_of_edge_sql, as_of_edge_params = _as_of_clause(as_of, "me.")
    scope_edge_sql, scope_edge_params = _scope_clause(scope, "me.")
    as_of_fact_sql, as_of_fact_params = _as_of_clause(as_of, "f.")
    scope_fact_sql, scope_fact_params = _scope_clause(scope, "f.")
    as_of_memory_sql, as_of_memory_params = _as_of_clause(as_of, "m.")
    scope_memory_sql, scope_memory_params = _scope_clause(scope, "m.")
    scope_episode_sql, scope_episode_params = _scope_clause(scope, "ep.")

    type_sql = ""
    type_params: list[str] = []
    if type_filter is not None:
        type_sql = "AND object_type = %s"
        type_params.append(type_filter)

    sql = f"""
        WITH seed(object_type, object_id) AS (
            VALUES {seed_sql}
        ),
        edges AS (
            SELECT
                me.edge_id::text,
                me.edge_type,
                me.confidence::float AS edge_confidence,
                me.source_type,
                me.source_id::text,
                me.target_type,
                me.target_id::text,
                CASE
                    WHEN me.source_type = s.object_type AND me.source_id = s.object_id
                    THEN me.target_type ELSE me.source_type
                END AS node_type,
                CASE
                    WHEN me.source_type = s.object_type AND me.source_id = s.object_id
                    THEN me.target_id ELSE me.source_id
                END AS node_id
            FROM preserve.memory_edge me
            JOIN seed s
              ON (
                me.source_type = s.object_type AND me.source_id = s.object_id
              ) OR (
                me.target_type = s.object_type AND me.target_id = s.object_id
              )
            WHERE me.tenant = %s
              AND me.assertion_class IN (%s, %s, %s)
              {as_of_edge_sql}
              {scope_edge_sql}
            ORDER BY me.confidence DESC, me.created_at DESC
            LIMIT %s
        ),
        nodes AS (
            SELECT * FROM edges
            WHERE NOT EXISTS (
                SELECT 1
                FROM seed s
                WHERE s.object_type = edges.node_type
                  AND s.object_id = edges.node_id
            )
        ),
        objects AS (
            SELECT
                n.node_id::text AS object_id,
                'fact' AS object_type,
                f.predicate AS title,
                COALESCE(f.object_value::text, '') AS summary,
                f.confidence::float,
                f.valid_from,
                f.valid_to,
                f.scope_path,
                f.priority,
                n.edge_id,
                n.edge_type,
                n.edge_confidence,
                n.source_type,
                n.source_id,
                n.target_type,
                n.target_id
            FROM nodes n
            JOIN preserve.fact f
              ON n.node_type = 'fact'
             AND f.fact_id = n.node_id
             AND f.tenant = %s
             AND f.current_status = 'active'
             {as_of_fact_sql}
             {scope_fact_sql}
            UNION ALL
            SELECT
                n.node_id::text AS object_id,
                'memory' AS object_type,
                m.title,
                m.narrative AS summary,
                m.confidence::float,
                m.valid_from,
                m.valid_to,
                m.scope_path,
                m.priority,
                n.edge_id,
                n.edge_type,
                n.edge_confidence,
                n.source_type,
                n.source_id,
                n.target_type,
                n.target_id
            FROM nodes n
            JOIN preserve.memory m
              ON n.node_type = 'memory'
             AND m.memory_id = n.node_id
             AND m.tenant = %s
             {as_of_memory_sql}
             {scope_memory_sql}
            UNION ALL
            SELECT
                n.node_id::text AS object_id,
                'episode' AS object_type,
                ep.title,
                ep.summary,
                NULL::float AS confidence,
                ep.start_at AS valid_from,
                ep.end_at AS valid_to,
                ep.scope_path,
                NULL::int AS priority,
                n.edge_id,
                n.edge_type,
                n.edge_confidence,
                n.source_type,
                n.source_id,
                n.target_type,
                n.target_id
            FROM nodes n
            JOIN preserve.episode ep
              ON n.node_type = 'episode'
             AND ep.episode_id = n.node_id
             AND ep.tenant = %s
             {scope_episode_sql}
        )
        SELECT *
        FROM objects
        WHERE TRUE {type_sql}
        ORDER BY edge_confidence DESC
        LIMIT %s
    """

    params = (
        seed_params
        + [TENANT, *GRAPH_ELIGIBLE_ASSERTION_CLASSES]
        + as_of_edge_params
        + scope_edge_params
        + [limit * 4]
        + [TENANT]
        + as_of_fact_params
        + scope_fact_params
        + [TENANT]
        + as_of_memory_params
        + scope_memory_params
        + [TENANT]
        + scope_episode_params
        + type_params
        + [limit * 2]
    )

    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    "SELECT set_config('statement_timeout', %s, true)",
                    [str(GRAPH_STREAM_TIMEOUT_MS)],
                )
                cur.execute(sql, params)
                rows = cur.fetchall()
    except (QueryCanceled, UndefinedTable) as exc:
        logger.warning("Graph path stream skipped: %s", exc)
        return []

    return [
        _Candidate(
            object_id=r["object_id"],
            object_type=r["object_type"],
            title=r["title"],
            summary=r["summary"],
            confidence=float(r["confidence"]) if r["confidence"] is not None else None,
            valid_from=_ts_str(r["valid_from"]),
            valid_to=_ts_str(r["valid_to"]),
            scope_path=r["scope_path"],
            priority=r.get("priority"),
            why=[
                {
                    "step": (
                        f"edge {r['edge_type']} ({r['edge_confidence']:.2f}) "
                        f"{r['source_type']}:{r['source_id']} -> "
                        f"{r['target_type']}:{r['target_id']}"
                    ),
                    "object_id": r["edge_id"],
                    "object_type": "memory_edge",
                }
            ],
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Evidence lookup (batch)
# ---------------------------------------------------------------------------

def _attach_evidence(
    pool: ConnectionPool,
    candidates: dict[str, _ScoredCandidate],
) -> None:
    """Attach evidence excerpts to fact and supported-memory candidates."""
    fact_ids = [
        cid for cid, sc in candidates.items()
        if sc.candidate.object_type == "fact"
    ]
    memory_ids = [
        cid for cid, sc in candidates.items()
        if sc.candidate.object_type == "memory"
    ]
    if not fact_ids and not memory_ids:
        return

    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            if fact_ids:
                placeholders = ",".join(["%s"] * len(fact_ids))
                sql = f"""
                    SELECT
                        fe.fact_id::text,
                        fe.segment_id::text,
                        fe.excerpt
                    FROM preserve.fact_evidence fe
                    WHERE fe.fact_id::text IN ({placeholders})
                    ORDER BY fe.weight DESC
                """
                cur.execute(sql, fact_ids)
                for r in cur.fetchall():
                    fid = r["fact_id"]
                    if fid in candidates:
                        candidates[fid].candidate.evidence.append({
                            "segment_id": r["segment_id"],
                            "excerpt": r["excerpt"],
                        })

            if memory_ids:
                placeholders = ",".join(["%s"] * len(memory_ids))
                sql = f"""
                    SELECT
                        ms.memory_id::text,
                        fe.segment_id::text,
                        fe.excerpt
                    FROM preserve.memory_support ms
                    JOIN preserve.fact f
                      ON f.fact_id = ms.fact_id
                     AND f.tenant = %s
                    JOIN preserve.fact_evidence fe
                      ON fe.fact_id = f.fact_id
                    WHERE ms.memory_id::text IN ({placeholders})
                    ORDER BY ms.memory_id, fe.weight DESC
                """
                cur.execute(sql, [TENANT] + memory_ids)
                for r in cur.fetchall():
                    mid = r["memory_id"]
                    if mid in candidates:
                        candidates[mid].candidate.evidence.append({
                            "segment_id": r["segment_id"],
                            "excerpt": r["excerpt"],
                        })


# ---------------------------------------------------------------------------
# RRF Fusion
# ---------------------------------------------------------------------------

def _rrf_fuse(
    stream_results: dict[str, list[_Candidate]],
    weights: dict[str, float],
) -> dict[str, _ScoredCandidate]:
    """Weighted Reciprocal Rank Fusion across multiple streams."""
    merged: dict[str, _ScoredCandidate] = {}

    for stream_name, candidates in stream_results.items():
        w = weights.get(stream_name, 0.0)
        for rank, cand in enumerate(candidates, start=1):
            rrf_score = w * (1.0 / (RRF_K + rank))
            if cand.object_id in merged:
                merged[cand.object_id].scores[stream_name] = (
                    merged[cand.object_id].scores.get(stream_name, 0.0) + rrf_score
                )
            else:
                merged[cand.object_id] = _ScoredCandidate(
                    candidate=cand,
                    scores={stream_name: rrf_score},
                )

    return merged


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def memory_search(
    pool: ConnectionPool,
    query: str,
    as_of: Optional[str] = None,
    scope: Optional[str] = None,
    type_filter: Optional[str] = None,
    limit: int = 10,
    include_graph: bool = False,
    explain_paths: bool = False,
) -> dict:
    """Hybrid search across the preserve schema.

    Returns a dict suitable for MemorySearchResponse serialization.
    """
    t0 = time.perf_counter()
    graph_enabled = include_graph or os.environ.get("BRAINCORE_GRAPH_RETRIEVAL") == "1"
    query_plan = _plan_query(query, scope)

    # -- Run streams 1-3 --
    structured = _stream_structured(pool, query, as_of, scope, type_filter, limit)
    fts = _stream_fts(pool, query, as_of, scope, type_filter, limit)
    vector = _stream_vector(pool, query, as_of, scope, type_filter, limit)

    stream_counts = {
        "structured": len(structured),
        "fts": len(fts),
        "vector": len(vector),
    }

    # -- RRF Fusion (streams 1-3) --
    if graph_enabled:
        weights = {
            "vector": 0.30,
            "structured": 0.22,
            "fts": 0.18,
            "temporal": 0.15,
            "graph": 0.15,
        }
    else:
        weights = {
            "vector": 0.35,
            "structured": 0.25,
            "fts": 0.20,
            "temporal": 0.20,
        }

    merged = _rrf_fuse(
        {"structured": structured, "fts": fts, "vector": vector},
        weights,
    )

    # -- Stream 4: Temporal expansion --
    temporal = _stream_temporal_expand(pool, merged, as_of, scope, limit)
    stream_counts["temporal"] = len(temporal)

    # Fuse temporal into merged
    for rank, cand in enumerate(temporal, start=1):
        rrf_score = weights["temporal"] * (1.0 / (RRF_K + rank))
        if cand.object_id in merged:
            merged[cand.object_id].scores["temporal"] = (
                merged[cand.object_id].scores.get("temporal", 0.0) + rrf_score
            )
        else:
            merged[cand.object_id] = _ScoredCandidate(
                candidate=cand,
                scores={"temporal": rrf_score},
            )

    if graph_enabled:
        graph = _stream_graph_path(pool, merged, as_of, scope, type_filter, limit)
        stream_counts["graph"] = len(graph)
        for rank, cand in enumerate(graph, start=1):
            rrf_score = weights["graph"] * (1.0 / (RRF_K + rank))
            if cand.object_id in merged:
                merged[cand.object_id].scores["graph"] = (
                    merged[cand.object_id].scores.get("graph", 0.0) + rrf_score
                )
                merged[cand.object_id].candidate.why.extend(cand.why)
            else:
                merged[cand.object_id] = _ScoredCandidate(
                    candidate=cand,
                    scores={"graph": rrf_score},
                )

    # Lifecycle status is an overlay. Suppressed/retired targets must not be
    # returned even when native tables still consider them active/published.
    _filter_lifecycle_hidden(pool, merged)

    # -- Attach evidence --
    _attach_evidence(pool, merged)

    # -- Sort and truncate --
    ranked = _rank_candidates(
        list(merged.values()),
        query_plan,
        LIGHTWEIGHT_RERANKING_ENABLED,
    )
    ranked = ranked[:limit]

    elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)

    results = []
    for sc in ranked:
        c = sc.candidate
        results.append({
            "object_id": c.object_id,
            "object_type": c.object_type,
            "title": c.title,
            "summary": c.summary,
            "confidence": c.confidence,
            "score": round(_display_score(sc, query_plan, LIGHTWEIGHT_RERANKING_ENABLED), 6),
            "priority": c.priority,
            "valid_from": c.valid_from,
            "valid_to": c.valid_to,
            "evidence": [
                {"segment_id": e.get("segment_id"), "excerpt": e.get("excerpt")}
                for e in c.evidence
            ],
            "why": c.why if explain_paths else [],
            "scope_path": c.scope_path,
        })

    return {
        "results": results,
        "query_time_ms": elapsed_ms,
        "stream_counts": stream_counts,
    }


def memory_timeline(
    pool: ConnectionPool,
    subject: Optional[str] = None,
    scope: Optional[str] = None,
    event_type: Optional[str] = None,
    from_ts: Optional[str] = None,
    to_ts: Optional[str] = None,
    include_evidence: bool = True,
    limit: int = 50,
) -> dict:
    """Return an ordered event-frame timeline for the process tenant.

    Timeline entries are read from ``preserve.event_frame`` only. This keeps the
    tool grounded in event-frame rows that already carry source fact and segment
    evidence pointers.
    """
    t0 = time.perf_counter()
    limit = max(1, min(limit, 200))
    scope_sql, scope_params = _scope_clause(scope, "ef.")
    tenant_sql, tenant_params = _tenant_clause(TENANT, "ef.")
    subject_sql, subject_params = _timeline_subject_clause(subject)
    time_sql, time_params = _timeline_time_clause(from_ts, to_ts)

    event_type_sql = ""
    event_type_params: list = []
    if event_type is not None:
        event_type_sql = "AND ef.event_type = %s"
        event_type_params.append(event_type)

    evidence_select = """
        fe.excerpt AS evidence_excerpt,
        fe.source_relpath AS evidence_source_relpath,
        fe.line_start AS evidence_line_start,
        fe.line_end AS evidence_line_end
    """ if include_evidence else """
        NULL::text AS evidence_excerpt,
        NULL::text AS evidence_source_relpath,
        NULL::integer AS evidence_line_start,
        NULL::integer AS evidence_line_end
    """

    evidence_join = """
        LEFT JOIN preserve.fact_evidence fe
          ON fe.fact_id = ef.source_fact_id
         AND fe.segment_id = ef.evidence_segment_id
    """ if include_evidence else ""

    sql = f"""
        SELECT
            ef.event_frame_id::text,
            ef.episode_id::text,
            ef.source_fact_id::text,
            ef.event_type,
            actor.canonical_name AS actor,
            ef.action,
            target.canonical_name AS target,
            location.canonical_name AS location,
            ef.object_value,
            ef.time_start,
            ef.time_end,
            ef.outcome,
            ef.confidence::float,
            ef.assertion_class::text,
            ef.scope_path,
            ef.evidence_segment_id::text,
            {evidence_select}
        FROM preserve.event_frame ef
        LEFT JOIN preserve.entity actor
          ON actor.entity_id = ef.actor_entity_id
         AND actor.tenant = %s
        LEFT JOIN preserve.entity target
          ON target.entity_id = ef.target_entity_id
         AND target.tenant = %s
        LEFT JOIN preserve.entity location
          ON location.entity_id = ef.location_entity_id
         AND location.tenant = %s
        {evidence_join}
        WHERE TRUE
          {tenant_sql}
          {scope_sql}
          {event_type_sql}
          {time_sql}
          {subject_sql}
        ORDER BY ef.time_start NULLS LAST, ef.created_at ASC, ef.event_frame_id
        LIMIT %s
    """

    params = (
        [TENANT, TENANT, TENANT]
        + tenant_params
        + scope_params
        + event_type_params
        + time_params
        + subject_params
        + [limit]
    )

    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
    except UndefinedTable:
        rows = []

    entries = []
    for row in rows:
        evidence = []
        if include_evidence and row.get("evidence_segment_id"):
            evidence.append({
                "segment_id": row.get("evidence_segment_id"),
                "excerpt": row.get("evidence_excerpt"),
                "source_relpath": row.get("evidence_source_relpath"),
                "line_start": row.get("evidence_line_start"),
                "line_end": row.get("evidence_line_end"),
            })
        entries.append({
            "timestamp": _ts_str(row["time_start"]),
            "time_end": _ts_str(row["time_end"]),
            "event_frame_id": row["event_frame_id"],
            "episode_id": row["episode_id"],
            "source_fact_id": row["source_fact_id"],
            "event_type": row["event_type"],
            "actor": row["actor"],
            "action": row["action"],
            "target": row["target"],
            "location": row["location"],
            "object_value": row["object_value"],
            "outcome": row["outcome"],
            "confidence": row["confidence"],
            "assertion_class": row["assertion_class"],
            "scope_path": row["scope_path"],
            "evidence": evidence,
        })

    return {
        "subject": subject,
        "entries": entries,
        "from_ts": from_ts,
        "to_ts": to_ts,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_before_after(
    pool: ConnectionPool,
    timestamp: str,
    subject: Optional[str] = None,
    scope: Optional[str] = None,
    event_type: Optional[str] = None,
    include_evidence: bool = True,
    limit_each: int = 3,
) -> dict:
    """Return nearest event frames before and after a timestamp."""
    t0 = time.perf_counter()
    limit_each = max(1, min(limit_each, 50))
    scope_sql, scope_params = _scope_clause(scope, "ef.")
    tenant_sql, tenant_params = _tenant_clause(TENANT, "ef.")
    subject_sql, subject_params = _timeline_subject_clause(subject)
    evidence_select, evidence_join = _event_frame_select_sql(include_evidence)

    event_type_sql = ""
    event_type_params: list = []
    if event_type is not None:
        event_type_sql = "AND ef.event_type = %s"
        event_type_params.append(event_type)

    base_sql = f"""
        SELECT
            ef.event_frame_id::text,
            ef.episode_id::text,
            ef.source_fact_id::text,
            ef.event_type,
            actor.canonical_name AS actor,
            ef.action,
            target.canonical_name AS target,
            location.canonical_name AS location,
            ef.object_value,
            ef.time_start,
            ef.time_end,
            ef.outcome,
            ef.confidence::float,
            ef.assertion_class::text,
            ef.scope_path,
            ef.evidence_segment_id::text,
            {evidence_select}
        FROM preserve.event_frame ef
        LEFT JOIN preserve.entity actor
          ON actor.entity_id = ef.actor_entity_id
         AND actor.tenant = %s
        LEFT JOIN preserve.entity target
          ON target.entity_id = ef.target_entity_id
         AND target.tenant = %s
        LEFT JOIN preserve.entity location
          ON location.entity_id = ef.location_entity_id
         AND location.tenant = %s
        {evidence_join}
        WHERE TRUE
          {tenant_sql}
          {scope_sql}
          {event_type_sql}
          {subject_sql}
    """
    base_params = (
        [TENANT, TENANT, TENANT]
        + tenant_params
        + scope_params
        + event_type_params
        + subject_params
    )

    before_sql = f"""
        {base_sql}
          AND ef.time_start < %s::timestamptz
        ORDER BY ef.time_start DESC NULLS LAST, ef.created_at DESC, ef.event_frame_id DESC
        LIMIT %s
    """
    after_sql = f"""
        {base_sql}
          AND ef.time_start >= %s::timestamptz
        ORDER BY ef.time_start ASC NULLS LAST, ef.created_at ASC, ef.event_frame_id ASC
        LIMIT %s
    """

    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(before_sql, base_params + [timestamp, limit_each])
                before_rows = cur.fetchall()
                cur.execute(after_sql, base_params + [timestamp, limit_each])
                after_rows = cur.fetchall()
    except UndefinedTable:
        before_rows = []
        after_rows = []

    before_entries = list(reversed(_timeline_entries_from_rows(before_rows, include_evidence)))
    after_entries = _timeline_entries_from_rows(after_rows, include_evidence)

    return {
        "timestamp": timestamp,
        "subject": subject,
        "before": before_entries,
        "after": after_entries,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_causal_chain(
    pool: ConnectionPool,
    subject: Optional[str] = None,
    scope: Optional[str] = None,
    from_ts: Optional[str] = None,
    to_ts: Optional[str] = None,
    include_evidence: bool = True,
    limit: int = 10,
) -> dict:
    """Return episode-grouped causal chains from grounded event frames."""
    t0 = time.perf_counter()
    limit = max(1, min(limit, 50))
    scope_sql, scope_params = _scope_clause(scope, "ef.")
    tenant_sql, tenant_params = _tenant_clause(TENANT, "ef.")
    subject_sql, subject_params = _timeline_subject_clause(subject)
    time_sql, time_params = _timeline_time_clause(from_ts, to_ts)
    evidence_select, evidence_join = _event_frame_select_sql(include_evidence)
    event_type_placeholders = ",".join(["%s"] * len(CAUSAL_CHAIN_EVENT_TYPES))

    sql = f"""
        WITH matching_episodes AS (
            SELECT ef.episode_id, min(ef.time_start) AS first_ts
            FROM preserve.event_frame ef
            LEFT JOIN preserve.entity actor
              ON actor.entity_id = ef.actor_entity_id
             AND actor.tenant = %s
            LEFT JOIN preserve.entity target
              ON target.entity_id = ef.target_entity_id
             AND target.tenant = %s
            LEFT JOIN preserve.entity location
              ON location.entity_id = ef.location_entity_id
             AND location.tenant = %s
            WHERE TRUE
              {tenant_sql}
              {scope_sql}
              {time_sql}
              {subject_sql}
              AND ef.event_type IN ({event_type_placeholders})
              AND ef.time_start IS NOT NULL
            GROUP BY ef.episode_id
            ORDER BY first_ts ASC
            LIMIT %s
        )
        SELECT
            ep.episode_id::text,
            ep.title AS episode_title,
            ep.outcome AS episode_outcome,
            ep.scope_path AS episode_scope_path,
            ef.event_frame_id::text,
            ef.source_fact_id::text,
            ef.event_type,
            actor.canonical_name AS actor,
            ef.action,
            target.canonical_name AS target,
            location.canonical_name AS location,
            ef.object_value,
            ef.time_start,
            ef.time_end,
            ef.outcome,
            ef.confidence::float,
            ef.assertion_class::text,
            ef.scope_path,
            ef.evidence_segment_id::text,
            {evidence_select}
        FROM matching_episodes me
        JOIN preserve.episode ep
          ON ep.episode_id = me.episode_id
         AND ep.tenant = %s
        JOIN preserve.event_frame ef
          ON ef.episode_id = me.episode_id
         AND ef.tenant = %s
        LEFT JOIN preserve.entity actor
          ON actor.entity_id = ef.actor_entity_id
         AND actor.tenant = %s
        LEFT JOIN preserve.entity target
          ON target.entity_id = ef.target_entity_id
         AND target.tenant = %s
        LEFT JOIN preserve.entity location
          ON location.entity_id = ef.location_entity_id
         AND location.tenant = %s
        {evidence_join}
        WHERE ef.event_type IN ({event_type_placeholders})
          {scope_sql}
          {time_sql}
          AND ef.time_start IS NOT NULL
        ORDER BY ep.start_at NULLS LAST, ep.created_at ASC,
                 ef.time_start ASC, ef.created_at ASC, ef.event_frame_id
    """
    params = (
        [TENANT, TENANT, TENANT]
        + tenant_params
        + scope_params
        + time_params
        + subject_params
        + list(CAUSAL_CHAIN_EVENT_TYPES)
        + [limit]
        + [TENANT, TENANT, TENANT, TENANT, TENANT]
        + list(CAUSAL_CHAIN_EVENT_TYPES)
        + scope_params
        + time_params
    )

    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
    except UndefinedTable:
        rows = []

    chains_by_episode: dict[str, dict] = {}
    for row in rows:
        episode_id = row["episode_id"]
        chain = chains_by_episode.setdefault(
            episode_id,
            {
                "episode_id": episode_id,
                "title": row["episode_title"],
                "outcome": row["episode_outcome"],
                "scope_path": row["episode_scope_path"],
                "steps": [],
            },
        )
        chain["steps"].extend(_timeline_entries_from_rows([row], include_evidence))

    return {
        "subject": subject,
        "chains": list(chains_by_episode.values()),
        "from_ts": from_ts,
        "to_ts": to_ts,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_search_procedure(
    pool: ConnectionPool,
    query: str,
    scope: Optional[str] = None,
    limit: int = 10,
) -> dict:
    """Search tenant-local procedural workflow memory."""
    t0 = time.perf_counter()
    limit = max(1, min(limit, 50))
    scope_sql, scope_params = _scope_clause(scope, "p.")
    tenant_sql, tenant_params = _tenant_clause(TENANT, "p.")
    pattern = f"%{query}%"

    def build_query(include_lifecycle_filter: bool) -> tuple[str, list]:
        lifecycle_sql = _lifecycle_procedure_visible_sql("p") if include_lifecycle_filter else ""
        if EMBEDDING_INDEX_RETRIEVAL_ENABLED:
            embedding = embed_query(query)
            emb_str = _vec_literal(embedding)
            sql = f"""
                WITH matches AS (
                    SELECT
                        p.procedure_id,
                        1 - (ei.embedding <=> %s::vector) AS rank
                    FROM preserve.embedding_index ei
                    JOIN preserve.procedure p
                      ON p.tenant = ei.tenant
                     AND p.procedure_id = ei.procedure_id
                    WHERE ei.tenant = %s
                      AND ei.vector_role = 'procedure'
                      AND ei.target_kind = 'procedure'
                      {tenant_sql}
                      {scope_sql}
                      AND p.lifecycle_state != 'retired'::preserve.lifecycle_state
                      {lifecycle_sql}
                    ORDER BY ei.embedding <=> %s::vector, p.confidence DESC, p.updated_at DESC
                    LIMIT %s
                )
                SELECT
                    p.procedure_id::text,
                    p.title,
                    p.summary,
                    p.confidence::float,
                    p.scope_path,
                    p.source_fact_id::text,
                    ps.procedure_step_id::text,
                    ps.step_index,
                    ps.action,
                    ps.expected_result
                FROM matches
                JOIN preserve.procedure p
                  ON p.procedure_id = matches.procedure_id
                 AND p.tenant = %s
                LEFT JOIN preserve.procedure_step ps
                  ON ps.procedure_id = p.procedure_id
                 AND ps.tenant = %s
                ORDER BY matches.rank DESC, p.confidence DESC, p.title ASC, ps.step_index ASC NULLS LAST
            """
            params = (
                [emb_str, TENANT]
                + tenant_params
                + scope_params
                + [emb_str, limit, TENANT, TENANT]
            )
            return sql, params

        sql = f"""
                WITH matches AS (
                    SELECT
                        p.procedure_id,
                        ts_rank(p.fts, plainto_tsquery('english', %s)) AS rank
                    FROM preserve.procedure p
                    WHERE TRUE
                      {tenant_sql}
                      {scope_sql}
                      AND p.lifecycle_state != 'retired'::preserve.lifecycle_state
                      {lifecycle_sql}
                      AND (
                        p.fts @@ plainto_tsquery('english', %s)
                        OR p.title ILIKE %s
                        OR p.summary ILIKE %s
                      )
                    ORDER BY rank DESC, p.confidence DESC, p.updated_at DESC
                    LIMIT %s
                )
                SELECT
                    p.procedure_id::text,
                    p.title,
                    p.summary,
                    p.confidence::float,
                    p.scope_path,
                    p.source_fact_id::text,
                    ps.procedure_step_id::text,
                    ps.step_index,
                    ps.action,
                    ps.expected_result
                FROM matches
                JOIN preserve.procedure p
                  ON p.procedure_id = matches.procedure_id
                 AND p.tenant = %s
                LEFT JOIN preserve.procedure_step ps
                  ON ps.procedure_id = p.procedure_id
                 AND ps.tenant = %s
                ORDER BY matches.rank DESC, p.confidence DESC, p.title ASC, ps.step_index ASC NULLS LAST
            """
        params = (
            [query]
            + tenant_params
            + scope_params
            + [query, pattern, pattern, limit, TENANT, TENANT]
        )
        return sql, params

    def execute(include_lifecycle_filter: bool) -> list[dict]:
        sql, params = build_query(include_lifecycle_filter)
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)
                return cur.fetchall()

    try:
        rows = execute(include_lifecycle_filter=True)
    except UndefinedTable as exc:
        rows = execute(include_lifecycle_filter=False) if _is_lifecycle_intelligence_missing(exc) else []

    results_by_id: dict[str, dict] = {}
    for row in rows:
        procedure_id = row["procedure_id"]
        result = results_by_id.setdefault(
            procedure_id,
            {
                "procedure_id": procedure_id,
                "title": row["title"],
                "summary": row["summary"],
                "confidence": row["confidence"],
                "scope_path": row["scope_path"],
                "source_fact_id": row["source_fact_id"],
                "steps": [],
            },
        )
        if row.get("procedure_step_id"):
            result["steps"].append({
                "step_index": row["step_index"],
                "action": row["action"],
                "expected_result": row["expected_result"],
            })

    return {
        "query": query,
        "results": list(results_by_id.values()),
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_next_step(
    pool: ConnectionPool,
    query: str,
    scope: Optional[str] = None,
    completed_steps: int = 0,
    limit: int = 10,
) -> dict:
    """Return the next evidence-grounded procedure step for matching procedures."""
    t0 = time.perf_counter()
    limit = max(1, min(limit, 50))
    completed_steps = max(0, int(completed_steps))
    scope_sql, scope_params = _scope_clause(scope, "p.")
    tenant_sql, tenant_params = _tenant_clause(TENANT, "p.")
    pattern = f"%{query}%"
    sql = f"""
        WITH matches AS (
            SELECT
                p.procedure_id,
                ts_rank(p.fts, plainto_tsquery('english', %s)) AS rank
            FROM preserve.procedure p
            WHERE TRUE
              {tenant_sql}
              {scope_sql}
              AND p.lifecycle_state != 'retired'::preserve.lifecycle_state
              {_lifecycle_procedure_visible_sql("p")}
              AND (
                p.fts @@ plainto_tsquery('english', %s)
                OR p.title ILIKE %s
                OR p.summary ILIKE %s
              )
            ORDER BY rank DESC, p.confidence DESC, p.updated_at DESC
            LIMIT %s
        )
        SELECT
            p.procedure_id::text,
            p.title AS procedure_title,
            p.summary AS procedure_summary,
            p.scope_path,
            p.source_fact_id::text AS procedure_source_fact_id,
            p.evidence_segment_id::text AS procedure_evidence_segment_id,
            ep.outcome AS episode_outcome,
            ps.procedure_step_id::text AS step_id,
            ps.step_index,
            ps.action,
            ps.expected_result,
            ps.source_fact_id::text AS step_source_fact_id,
            ps.evidence_segment_id::text AS step_evidence_segment_id,
            ps.confidence::float
        FROM matches
        JOIN preserve.procedure p
          ON p.procedure_id = matches.procedure_id
         AND p.tenant = %s
        LEFT JOIN preserve.episode ep
          ON ep.episode_id = p.source_episode_id
         AND ep.tenant = %s
        JOIN LATERAL (
            SELECT *
            FROM preserve.procedure_step ps
            WHERE ps.tenant = %s
              AND ps.procedure_id = p.procedure_id
              AND ps.step_index > %s
            ORDER BY ps.step_index ASC
            LIMIT 1
        ) ps ON TRUE
        ORDER BY matches.rank DESC, p.confidence DESC, ps.step_index ASC
        LIMIT %s
    """
    params = (
        [query]
        + tenant_params
        + scope_params
        + [query, pattern, pattern, limit, TENANT, TENANT, TENANT, completed_steps, limit]
    )
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
    except UndefinedTable:
        rows = []
    return {
        "query": query,
        "results": [_procedure_operational_step_from_row(row) for row in rows],
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_what_did_we_try(
    pool: ConnectionPool,
    query: str,
    scope: Optional[str] = None,
    limit: int = 20,
) -> dict:
    """Return prior procedure steps with evidence and prior outcome data."""
    return _memory_procedure_steps(pool, query, scope, limit, failed_only=False)


def memory_failed_remediations(
    pool: ConnectionPool,
    query: str,
    scope: Optional[str] = None,
    limit: int = 20,
) -> dict:
    """Return prior procedure steps whose outcome data indicates failure."""
    return _memory_procedure_steps(pool, query, scope, limit, failed_only=True)


def _memory_procedure_steps(
    pool: ConnectionPool,
    query: str,
    scope: Optional[str],
    limit: int,
    failed_only: bool,
) -> dict:
    t0 = time.perf_counter()
    limit = max(1, min(limit, 100))
    scope_sql, scope_params = _scope_clause(scope, "p.")
    tenant_sql, tenant_params = _tenant_clause(TENANT, "p.")
    pattern = f"%{query}%"
    failed_sql = ""
    failed_params: list = []
    if failed_only:
        failed_sql = """
          AND (
            lower(COALESCE(ep.outcome, '')) ~ %s
            OR lower(COALESCE(p.summary, '')) ~ %s
            OR lower(COALESCE(ps.expected_result, '')) ~ %s
            OR lower(COALESCE(ps.step_json::text, '')) ~ %s
          )
        """
        failed_params = [FAILED_REMEDIATION_PATTERN] * 4
    sql = f"""
        SELECT
            p.procedure_id::text,
            p.title AS procedure_title,
            p.summary AS procedure_summary,
            p.scope_path,
            p.source_fact_id::text AS procedure_source_fact_id,
            p.evidence_segment_id::text AS procedure_evidence_segment_id,
            ep.outcome AS episode_outcome,
            ps.procedure_step_id::text AS step_id,
            ps.step_index,
            ps.action,
            ps.expected_result,
            ps.source_fact_id::text AS step_source_fact_id,
            ps.evidence_segment_id::text AS step_evidence_segment_id,
            ps.confidence::float
        FROM preserve.procedure p
        JOIN preserve.procedure_step ps
          ON ps.procedure_id = p.procedure_id
         AND ps.tenant = %s
        LEFT JOIN preserve.episode ep
          ON ep.episode_id = p.source_episode_id
         AND ep.tenant = %s
        WHERE TRUE
          {tenant_sql}
          {scope_sql}
          AND p.lifecycle_state != 'retired'::preserve.lifecycle_state
          {_lifecycle_procedure_visible_sql("p")}
          AND (
            p.fts @@ plainto_tsquery('english', %s)
            OR p.title ILIKE %s
            OR p.summary ILIKE %s
            OR ps.action ILIKE %s
            OR ps.expected_result ILIKE %s
          )
          {failed_sql}
        ORDER BY p.updated_at DESC, p.confidence DESC, ps.step_index ASC
        LIMIT %s
    """
    params = (
        [TENANT, TENANT]
        + tenant_params
        + scope_params
        + [query, pattern, pattern, pattern, pattern]
        + failed_params
        + [limit]
    )
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
    except UndefinedTable:
        rows = []
    return {
        "query": query,
        "results": [_procedure_operational_step_from_row(row) for row in rows],
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_session_start(
    pool: ConnectionPool,
    session_key: str,
    agent_name: str,
    task_title: Optional[str] = None,
    scope: Optional[str] = None,
    ttl_days: int = DEFAULT_WORKING_MEMORY_TTL_DAYS,
) -> dict:
    """Start or resume a tenant-local working-memory task session."""
    t0 = time.perf_counter()
    ttl_days = _bounded_ttl_days(ttl_days)
    sql = """
        INSERT INTO preserve.task_session (
            tenant,
            session_key,
            agent_name,
            task_title,
            status,
            scope_path,
            expires_at,
            session_json
        )
        VALUES (
            %s,
            %s,
            %s,
            %s,
            'active',
            %s,
            now() + (%s::int * interval '1 day'),
            '{"source":"memory-session-start"}'::jsonb
        )
        ON CONFLICT (tenant, session_key) DO UPDATE
          SET agent_name = EXCLUDED.agent_name,
              task_title = COALESCE(EXCLUDED.task_title, preserve.task_session.task_title),
              status = 'active',
              scope_path = COALESCE(EXCLUDED.scope_path, preserve.task_session.scope_path),
              expires_at = EXCLUDED.expires_at,
              last_seen_at = now(),
              updated_at = now()
        RETURNING
            session_id::text,
            session_key,
            agent_name,
            task_title,
            status,
            scope_path,
            started_at,
            last_seen_at,
            ended_at,
            expires_at
    """
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, [TENANT, session_key, agent_name, task_title, scope, ttl_days])
                row = cur.fetchone()
    except UndefinedTable:
        row = None
    return {
        "session": _task_session_from_row(row) if row else None,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_session_update(
    pool: ConnectionPool,
    session_key: str,
    status: Optional[str] = None,
    task_title: Optional[str] = None,
    scope: Optional[str] = None,
) -> dict:
    """Update a tenant-local task session."""
    t0 = time.perf_counter()
    sql = """
        UPDATE preserve.task_session
        SET status = COALESCE(%s, status),
            task_title = COALESCE(%s, task_title),
            scope_path = COALESCE(%s, scope_path),
            last_seen_at = now(),
            updated_at = now()
        WHERE tenant = %s
          AND session_key = %s
        RETURNING
            session_id::text,
            session_key,
            agent_name,
            task_title,
            status,
            scope_path,
            started_at,
            last_seen_at,
            ended_at,
            expires_at
    """
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, [status, task_title, scope, TENANT, session_key])
                row = cur.fetchone()
    except UndefinedTable:
        row = None
    return {
        "session": _task_session_from_row(row) if row else None,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_session_close(
    pool: ConnectionPool,
    session_key: str,
    status: str = "completed",
) -> dict:
    """Close a task session as completed or failed."""
    t0 = time.perf_counter()
    if status not in ("completed", "failed"):
        raise ValueError("session close status must be completed or failed")
    sql = """
        UPDATE preserve.task_session
        SET status = %s,
            ended_at = COALESCE(ended_at, now()),
            last_seen_at = now(),
            updated_at = now()
        WHERE tenant = %s
          AND session_key = %s
        RETURNING
            session_id::text,
            session_key,
            agent_name,
            task_title,
            status,
            scope_path,
            started_at,
            last_seen_at,
            ended_at,
            expires_at
    """
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, [status, TENANT, session_key])
                row = cur.fetchone()
    except UndefinedTable:
        row = None
    return {
        "session": _task_session_from_row(row) if row else None,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_session_list_active(
    pool: ConnectionPool,
    scope: Optional[str] = None,
    limit: int = 50,
) -> dict:
    """List active/idle non-expired task sessions."""
    t0 = time.perf_counter()
    limit = max(1, min(limit, 200))
    scope_sql, scope_params = _scope_clause(scope, "")
    sql = f"""
        SELECT
            session_id::text,
            session_key,
            agent_name,
            task_title,
            status,
            scope_path,
            started_at,
            last_seen_at,
            ended_at,
            expires_at
        FROM preserve.task_session
        WHERE tenant = %s
          AND status IN ('active', 'idle')
          AND (expires_at IS NULL OR expires_at > now())
          {scope_sql}
        ORDER BY last_seen_at DESC
        LIMIT %s
    """
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, [TENANT] + scope_params + [limit])
                rows = cur.fetchall()
    except UndefinedTable:
        rows = []
    return {
        "sessions": [_task_session_from_row(row) for row in rows],
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_working_add(
    pool: ConnectionPool,
    session_key: str,
    memory_kind: str,
    content: str,
    source_segment_id: Optional[str] = None,
    source_fact_id: Optional[str] = None,
    evidence_segment_id: Optional[str] = None,
    ttl_days: int = DEFAULT_WORKING_MEMORY_TTL_DAYS,
) -> dict:
    """Add a working-memory item to an active non-expired session."""
    t0 = time.perf_counter()
    ttl_days = _bounded_ttl_days(ttl_days)
    fp = _working_memory_fingerprint([
        TENANT,
        session_key,
        memory_kind,
        content,
        source_segment_id,
        source_fact_id,
        evidence_segment_id,
    ])
    sql = """
        WITH session AS (
            SELECT session_id
            FROM preserve.task_session
            WHERE tenant = %s
              AND session_key = %s
              AND status IN ('active', 'idle')
              AND (expires_at IS NULL OR expires_at > now())
            LIMIT 1
        )
        INSERT INTO preserve.working_memory (
            tenant,
            session_id,
            working_memory_fingerprint,
            memory_kind,
            content,
            source_segment_id,
            source_fact_id,
            evidence_segment_id,
            expires_at
        )
        SELECT
            %s,
            session_id,
            %s,
            %s,
            %s,
            %s,
            %s,
            %s,
            now() + (%s::int * interval '1 day')
        FROM session
        ON CONFLICT (tenant, working_memory_fingerprint) DO UPDATE
          SET content = EXCLUDED.content,
              expires_at = EXCLUDED.expires_at,
              updated_at = now()
        RETURNING
            working_memory_id::text,
            tenant,
            session_id::text,
            memory_kind,
            content,
            promotion_status,
            promotion_reason,
            promotion_target_kind,
            promotion_target_id::text,
            expires_at,
            created_at
    """
    params = [
        TENANT,
        session_key,
        TENANT,
        fp,
        memory_kind,
        content,
        source_segment_id,
        source_fact_id,
        evidence_segment_id,
        ttl_days,
    ]
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)
                row = cur.fetchone()
    except UndefinedTable:
        row = None
    return {
        "item": _working_memory_from_row(row) if row else None,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_working_list(
    pool: ConnectionPool,
    session_key: Optional[str] = None,
    promotion_status: Optional[str] = None,
    include_expired: bool = False,
    limit: int = 50,
) -> dict:
    """List working-memory items, excluding expired rows by default."""
    t0 = time.perf_counter()
    limit = max(1, min(limit, 200))
    sql = """
        SELECT
            wm.working_memory_id::text,
            wm.tenant,
            wm.session_id::text,
            ts.session_key,
            wm.memory_kind,
            wm.content,
            wm.promotion_status,
            wm.promotion_reason,
            wm.promotion_target_kind,
            wm.promotion_target_id::text,
            wm.expires_at,
            wm.created_at
        FROM preserve.working_memory wm
        JOIN preserve.task_session ts
          ON ts.tenant = wm.tenant
         AND ts.session_id = wm.session_id
        WHERE wm.tenant = %s
          AND (%s::text IS NULL OR ts.session_key = %s)
          AND (%s::boolean OR wm.expires_at > now())
          AND (%s::text IS NULL OR wm.promotion_status = %s)
        ORDER BY wm.created_at DESC
        LIMIT %s
    """
    params = [
        TENANT,
        session_key,
        session_key or "",
        include_expired,
        promotion_status,
        promotion_status or "",
        limit,
    ]
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
    except UndefinedTable:
        rows = []
    return {
        "items": [_working_memory_from_row(row) for row in rows],
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_working_mark_promotion_candidate(
    pool: ConnectionPool,
    working_memory_id: str,
    promotion_reason: str,
    promotion_target_kind: Optional[str] = None,
    promotion_target_id: Optional[str] = None,
) -> dict:
    """Mark an evidence-backed item from a closed session as a candidate."""
    t0 = time.perf_counter()
    sql = """
        UPDATE preserve.working_memory wm
        SET promotion_status = 'promotion_candidate',
            promotion_reason = %s,
            promotion_target_kind = %s,
            promotion_target_id = %s,
            promotion_marked_at = now(),
            updated_at = now()
        FROM preserve.task_session ts
        WHERE wm.tenant = %s
          AND wm.working_memory_id = %s
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
            wm.working_memory_id::text,
            wm.tenant,
            wm.session_id::text,
            ts.session_key,
            wm.memory_kind,
            wm.content,
            wm.promotion_status,
            wm.promotion_reason,
            wm.promotion_target_kind,
            wm.promotion_target_id::text,
            wm.expires_at,
            wm.created_at
    """
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, [
                    promotion_reason,
                    promotion_target_kind,
                    promotion_target_id,
                    TENANT,
                    working_memory_id,
                ])
                row = cur.fetchone()
    except UndefinedTable:
        row = None
    return {
        "item": _working_memory_from_row(row) if row else None,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_working_cleanup_expired(
    pool: ConnectionPool,
    limit: int = 500,
) -> dict:
    """Mark expired unpromoted working-memory rows as expired."""
    t0 = time.perf_counter()
    limit = max(1, min(limit, 5000))
    sql = """
        WITH expired AS (
            SELECT working_memory_id
            FROM preserve.working_memory
            WHERE tenant = %s
              AND expires_at <= now()
              AND promotion_status IN ('not_promoted', 'promotion_candidate', 'rejected')
            ORDER BY expires_at ASC
            LIMIT %s
        )
        UPDATE preserve.working_memory wm
        SET promotion_status = 'expired',
            updated_at = now()
        FROM expired
        WHERE wm.working_memory_id = expired.working_memory_id
        RETURNING wm.working_memory_id::text
    """
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, [TENANT, limit])
                rows = cur.fetchall()
    except UndefinedTable:
        rows = []
    return {
        "expired": len(rows),
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def lifecycle_event_enqueue(
    pool: ConnectionPool,
    event_id: str,
    event_type: str,
    source_service: str,
    target_kind: Optional[str] = None,
    target_id: Optional[str] = None,
    scope: Optional[str] = None,
    session_key: Optional[str] = None,
    trace_id: Optional[str] = None,
    payload: Optional[dict] = None,
    evidence_refs: Optional[list] = None,
) -> dict:
    """Enqueue an idempotent lifecycle event without mutating native memory tables."""
    t0 = time.perf_counter()
    _require_choice(event_type, LIFECYCLE_EVENT_TYPES, "event_type")
    _require_choice(target_kind, LIFECYCLE_TARGET_KINDS, "target_kind")
    if not _target_pair_valid(target_kind, target_id):
        raise ValueError("target_kind and target_id must be supplied together")
    idempotency_key = f"{source_service}:{event_id}"
    sql = """
        INSERT INTO preserve.lifecycle_outbox (
            tenant,
            event_id,
            idempotency_key,
            event_type,
            source_service,
            scope_path,
            session_key,
            trace_id,
            target_kind,
            target_id,
            payload,
            evidence_refs
        )
        VALUES (
            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
            %s::jsonb,
            %s::jsonb
        )
        ON CONFLICT (tenant, idempotency_key) DO UPDATE
          SET received_at = preserve.lifecycle_outbox.received_at
        RETURNING
            outbox_id::text,
            tenant,
            event_id,
            event_type,
            source_service,
            status,
            target_kind,
            target_id::text,
            attempt_count,
            received_at
    """
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                if target_kind and target_id:
                    _assert_target_exists(cur, target_kind, target_id)
                cur.execute(sql, [
                    TENANT,
                    event_id,
                    idempotency_key,
                    event_type,
                    source_service,
                    scope,
                    session_key,
                    trace_id,
                    target_kind,
                    target_id,
                    json.dumps(payload or {}),
                    json.dumps(evidence_refs or []),
                ])
                row = cur.fetchone()
    except UndefinedTable:
        row = None
    return {
        "event": row,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def lifecycle_event_list(
    pool: ConnectionPool,
    status: Optional[str] = None,
    limit: int = 50,
) -> dict:
    """List tenant-local lifecycle outbox events."""
    t0 = time.perf_counter()
    _require_choice(status, LIFECYCLE_OUTBOX_STATUSES, "status")
    limit = max(1, min(limit, 500))
    sql = """
        SELECT
            outbox_id::text,
            tenant,
            event_id,
            event_type,
            source_service,
            status,
            target_kind,
            target_id::text,
            attempt_count,
            received_at
        FROM preserve.lifecycle_outbox
        WHERE tenant = %s
          AND (%s::text IS NULL OR status = %s)
        ORDER BY received_at DESC
        LIMIT %s
    """
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, [TENANT, status, status or "", limit])
                rows = cur.fetchall()
    except UndefinedTable:
        rows = []
    return {
        "events": rows,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def lifecycle_event_retry(
    pool: ConnectionPool,
    outbox_id: str,
) -> dict:
    """Move a failed/dead-letter lifecycle event back to pending."""
    t0 = time.perf_counter()
    sql = """
        UPDATE preserve.lifecycle_outbox
        SET status = 'pending',
            next_attempt_at = now(),
            claimed_at = NULL,
            claimed_by = NULL,
            error_summary = NULL
        WHERE tenant = %s
          AND outbox_id = %s
          AND status IN ('failed','dead_letter')
        RETURNING outbox_id::text
    """
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, [TENANT, outbox_id])
                row = cur.fetchone()
    except UndefinedTable:
        row = None
    return {
        "retried": row is not None,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def lifecycle_intelligence_backfill(
    pool: ConnectionPool,
    target_kind: str = "all",
    limit: int = 1000,
) -> dict:
    """Backfill lifecycle intelligence rows for existing tenant-local targets."""
    t0 = time.perf_counter()
    if target_kind != "all":
        _require_choice(target_kind, LIFECYCLE_TARGET_KINDS, "target_kind")
    limit = max(1, min(limit, 10000))
    table_by_kind = {
        "fact": ("fact", "fact_id", "semantic"),
        "memory": ("memory", "memory_id", "semantic"),
        "procedure": ("procedure", "procedure_id", "procedural"),
        "event_frame": ("event_frame", "event_frame_id", "semantic"),
        "working_memory": ("working_memory", "working_memory_id", "working"),
    }
    kinds = list(table_by_kind.keys()) if target_kind == "all" else [target_kind]
    inserted = 0
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                for kind in kinds:
                    table, id_column, horizon = table_by_kind[kind]
                    cur.execute(
                        f"""
                        WITH candidates AS (
                            SELECT source.tenant, source.{id_column} AS target_id
                            FROM preserve.{table} source
                            WHERE source.tenant = %s
                              AND NOT EXISTS (
                                SELECT 1
                                FROM preserve.lifecycle_target_intelligence lti
                                WHERE lti.tenant = source.tenant
                                  AND lti.target_kind = %s
                                  AND lti.target_id = source.{id_column}
                              )
                            ORDER BY source.{id_column}
                            LIMIT %s
                        )
                        INSERT INTO preserve.lifecycle_target_intelligence (
                            tenant, target_kind, target_id, source_derivation_type, horizon, lifecycle_status
                        )
                        SELECT tenant, %s, target_id, 'imported_knowledge', %s, 'active'
                        FROM candidates
                        ON CONFLICT (tenant, target_kind, target_id) DO NOTHING
                        RETURNING intelligence_id::text
                        """,
                        [TENANT, kind, limit, kind, horizon],
                    )
                    inserted += len(cur.fetchall())
    except UndefinedTable:
        inserted = 0
    return {
        "inserted": inserted,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def lifecycle_stats(pool: ConnectionPool) -> dict:
    """Return lifecycle outbox and target intelligence counts."""
    t0 = time.perf_counter()
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT
                        count(*) AS total,
                        count(*) FILTER (WHERE status = 'pending') AS pending,
                        count(*) FILTER (WHERE status = 'processing') AS processing,
                        count(*) FILTER (WHERE status = 'failed') AS failed,
                        count(*) FILTER (WHERE status = 'dead_letter') AS dead_letter
                    FROM preserve.lifecycle_outbox
                    WHERE tenant = %s
                    """,
                    [TENANT],
                )
                outbox = cur.fetchone() or {}
                cur.execute(
                    """
                    SELECT
                        count(*) AS total,
                        count(*) FILTER (WHERE lifecycle_status = 'review_required') AS review_required,
                        count(*) FILTER (WHERE lifecycle_status = 'suppressed') AS suppressed,
                        count(*) FILTER (WHERE lifecycle_status = 'retired') AS retired
                    FROM preserve.lifecycle_target_intelligence
                    WHERE tenant = %s
                    """,
                    [TENANT],
                )
                intelligence = cur.fetchone() or {}
    except UndefinedTable:
        outbox = {}
        intelligence = {}
    return {
        "tenant": TENANT,
        "outbox": outbox,
        "intelligence": intelligence,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_lifecycle_status_set(
    pool: ConnectionPool,
    target_kind: str,
    target_id: str,
    status: str,
    reason: str,
    actor_type: str = "admin",
    actor_id: Optional[str] = None,
) -> dict:
    """Set lifecycle intelligence status only; native truth rows are untouched."""
    t0 = time.perf_counter()
    _require_choice(target_kind, LIFECYCLE_TARGET_KINDS, "target_kind")
    _require_choice(status, LIFECYCLE_STATUSES, "status")
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _assert_target_exists(cur, target_kind, target_id)
                cur.execute(
                    """
                    INSERT INTO preserve.lifecycle_target_intelligence (
                        tenant, target_kind, target_id, source_derivation_type, lifecycle_status
                    )
                    VALUES (%s, %s, %s, 'corrected_by_user', %s)
                    ON CONFLICT (tenant, target_kind, target_id) DO NOTHING
                    """,
                    [TENANT, target_kind, target_id, status],
                )
                cur.execute(
                    """
                    UPDATE preserve.lifecycle_target_intelligence
                    SET lifecycle_status = %s,
                        lock_version = lock_version + 1
                    WHERE tenant = %s
                      AND target_kind = %s
                      AND target_id = %s
                    RETURNING
                        target_kind,
                        target_id::text,
                        lifecycle_status,
                        lock_version
                    """,
                    [status, TENANT, target_kind, target_id],
                )
                row = cur.fetchone()
                cur.execute(
                    """
                    INSERT INTO preserve.lifecycle_audit_log (
                        tenant, actor_type, actor_id, action, target_kind, target_id, reason
                    )
                    VALUES (%s, %s, %s, 'admin_status_change', %s, %s, %s)
                    """,
                    [TENANT, actor_type, actor_id, target_kind, target_id, reason],
                )
    except UndefinedTable:
        row = None
    return {
        "target": row,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_lifecycle_feedback_record(
    pool: ConnectionPool,
    target_kind: str,
    target_id: str,
    signal: str,
    actor_type: str = "admin",
    actor_id: Optional[str] = None,
    outcome: Optional[str] = None,
    details: Optional[dict] = None,
) -> dict:
    """Append lifecycle feedback and audit rows without changing native memory truth."""
    t0 = time.perf_counter()
    _require_choice(target_kind, LIFECYCLE_TARGET_KINDS, "target_kind")
    _require_choice(signal, LIFECYCLE_FEEDBACK_SIGNALS, "signal")
    if details and details.get("requested_native_mutation"):
        raise ValueError("Lifecycle feedback cannot request native BrainCore truth mutation")
    score_delta = {
        "signal": signal,
        "native_mutation": False,
    }
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                _assert_target_exists(cur, target_kind, target_id)
                cur.execute(
                    """
                    INSERT INTO preserve.lifecycle_target_intelligence (
                        tenant, target_kind, target_id, source_derivation_type, lifecycle_status
                    )
                    VALUES (%s, %s, %s, 'feedback_derived', 'active')
                    ON CONFLICT (tenant, target_kind, target_id) DO NOTHING
                    """,
                    [TENANT, target_kind, target_id],
                )
                cur.execute(
                    """
                    INSERT INTO preserve.lifecycle_feedback_event (
                        tenant,
                        target_kind,
                        target_id,
                        signal,
                        outcome,
                        score_delta,
                        actor_type,
                        actor_id,
                        details
                    )
                    VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s::jsonb)
                    RETURNING feedback_id::text
                    """,
                    [
                        TENANT,
                        target_kind,
                        target_id,
                        signal,
                        outcome,
                        json.dumps(score_delta),
                        actor_type,
                        actor_id,
                        json.dumps(details or {}),
                    ],
                )
                feedback = cur.fetchone()
                cur.execute(
                    """
                    INSERT INTO preserve.lifecycle_audit_log (
                        tenant, actor_type, actor_id, action, target_kind, target_id, feedback_id, details
                    )
                    VALUES (%s, %s, %s, 'feedback_recorded', %s, %s, %s, %s::jsonb)
                    """,
                    [
                        TENANT,
                        actor_type,
                        actor_id,
                        target_kind,
                        target_id,
                        feedback["feedback_id"] if feedback else None,
                        json.dumps({"signal": signal}),
                    ],
                )
    except UndefinedTable:
        feedback = None
    return {
        "feedback": feedback,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def context_recall_audit_record(
    pool: ConnectionPool,
    trigger: str,
    mode: str,
    max_tokens: int,
    injected: bool = False,
    scope: Optional[str] = None,
    session_key: Optional[str] = None,
    goal: Optional[str] = None,
    cues: Optional[list] = None,
    retrieved: Optional[list] = None,
    prompt_package: Optional[list] = None,
    omitted: Optional[list] = None,
    total_tokens: int = 0,
) -> dict:
    """Record context recall audit metadata for shadow/eval/default-on recall."""
    t0 = time.perf_counter()
    _require_choice(trigger, (
        "session_start", "mission_start", "pre_model_call", "tool_failure",
        "task_failure", "context_compacted", "memory_protocol",
    ), "trigger")
    _require_choice(mode, ("off", "shadow", "eval", "default_on"), "mode")
    sql = """
        INSERT INTO preserve.context_recall_audit (
            tenant,
            trigger,
            mode,
            injected,
            scope_path,
            session_key,
            goal,
            cues,
            retrieved,
            prompt_package,
            omitted,
            total_tokens,
            max_tokens
        )
        VALUES (
            %s, %s, %s, %s, %s, %s, %s,
            %s::jsonb,
            %s::jsonb,
            %s::jsonb,
            %s::jsonb,
            %s,
            %s
        )
        RETURNING context_audit_id::text
    """
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, [
                    TENANT,
                    trigger,
                    mode,
                    injected,
                    scope,
                    session_key,
                    goal,
                    json.dumps(cues or []),
                    json.dumps(retrieved or []),
                    json.dumps(prompt_package or []),
                    json.dumps(omitted or []),
                    max(0, int(total_tokens)),
                    max(1, int(max_tokens)),
                ])
                row = cur.fetchone()
    except UndefinedTable:
        row = None
    return {
        "context_audit": row,
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


def memory_search_visual(
    pool: ConnectionPool,
    query: str,
    scope: Optional[str] = None,
    media_type: Optional[str] = None,
    limit: int = 10,
) -> dict:
    """Search visual OCR/caption/layout metadata without exposing raw artifacts."""
    t0 = time.perf_counter()
    limit = max(1, min(limit, 100))
    pattern = f"%{query.strip()}%"
    scope_prefix = f"{scope}%" if scope else None
    sql = """
        WITH media_matches AS (
            SELECT
                'media_artifact'::text AS result_type,
                ma.media_artifact_id::text AS media_artifact_id,
                NULL::text AS visual_region_id,
                ma.media_type,
                ma.mime_type,
                ma.scope_path,
                NULL::integer AS page_number,
                NULL::text AS region_type,
                NULL::text AS label,
                COALESCE(
                  ma.media_meta->>'caption',
                  ma.media_meta->>'description',
                  ma.media_meta->>'title',
                  ma.media_meta->>'alt_text'
                ) AS text,
                ma.artifact_id::text AS artifact_id,
                ma.source_segment_id::text AS source_segment_id,
                NULL::text AS linked_entity_id,
                NULL::text AS linked_fact_id,
                NULL::text AS linked_memory_id,
                NULL::text AS linked_procedure_id,
                NULL::numeric AS x_min,
                NULL::numeric AS y_min,
                NULL::numeric AS x_max,
                NULL::numeric AS y_max,
                NULL::numeric AS confidence,
                ma.ingest_run_id::text AS ingest_run_id,
                ma.ingest_batch_key,
                2 AS rank_group,
                ma.created_at
            FROM preserve.media_artifact ma
            WHERE ma.tenant = %s
              AND (%s::text IS NULL OR COALESCE(ma.scope_path, '') LIKE %s)
              AND (%s::text IS NULL OR ma.media_type = %s)
              AND (
                ma.media_type ILIKE %s
                OR ma.mime_type ILIKE %s
                OR COALESCE(ma.media_meta->>'caption', '') ILIKE %s
                OR COALESCE(ma.media_meta->>'description', '') ILIKE %s
                OR COALESCE(ma.media_meta->>'title', '') ILIKE %s
                OR COALESCE(ma.media_meta->>'alt_text', '') ILIKE %s
              )
        ),
        region_matches AS (
            SELECT
                'visual_region'::text AS result_type,
                ma.media_artifact_id::text AS media_artifact_id,
                vr.visual_region_id::text AS visual_region_id,
                ma.media_type,
                ma.mime_type,
                COALESCE(vr.region_meta->>'scope_path', ma.scope_path) AS scope_path,
                vr.page_number,
                vr.region_type,
                vr.label,
                COALESCE(
                  vr.region_meta->>'ocr_text',
                  vr.region_meta->>'caption',
                  vr.region_meta->>'text',
                  vr.label
                ) AS text,
                ma.artifact_id::text AS artifact_id,
                COALESCE(vr.source_segment_id, ma.source_segment_id)::text AS source_segment_id,
                vr.linked_entity_id::text AS linked_entity_id,
                vr.linked_fact_id::text AS linked_fact_id,
                vr.linked_memory_id::text AS linked_memory_id,
                vr.linked_procedure_id::text AS linked_procedure_id,
                vr.x_min,
                vr.y_min,
                vr.x_max,
                vr.y_max,
                vr.confidence,
                COALESCE(vr.ingest_run_id, ma.ingest_run_id)::text AS ingest_run_id,
                COALESCE(vr.ingest_batch_key, ma.ingest_batch_key) AS ingest_batch_key,
                1 AS rank_group,
                vr.created_at
            FROM preserve.visual_region vr
            JOIN preserve.media_artifact ma
              ON ma.tenant = vr.tenant
             AND ma.media_artifact_id = vr.media_artifact_id
            WHERE vr.tenant = %s
              AND (%s::text IS NULL OR COALESCE(vr.region_meta->>'scope_path', ma.scope_path, '') LIKE %s)
              AND (%s::text IS NULL OR ma.media_type = %s)
              AND (
                vr.region_type ILIKE %s
                OR COALESCE(vr.label, '') ILIKE %s
                OR COALESCE(vr.region_meta->>'ocr_text', '') ILIKE %s
                OR COALESCE(vr.region_meta->>'caption', '') ILIKE %s
                OR COALESCE(vr.region_meta->>'text', '') ILIKE %s
              )
        )
        SELECT *
        FROM (
            SELECT * FROM region_matches
            UNION ALL
            SELECT * FROM media_matches
        ) matches
        ORDER BY rank_group, confidence DESC NULLS LAST, created_at DESC
        LIMIT %s
    """
    params = [
        TENANT,
        scope_prefix,
        scope_prefix or "",
        media_type,
        media_type or "",
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        TENANT,
        scope_prefix,
        scope_prefix or "",
        media_type,
        media_type or "",
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        limit,
    ]
    try:
        with pool.connection() as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
    except UndefinedTable:
        rows = []
    return {
        "query": query,
        "results": [_visual_result_from_row(row) for row in rows],
        "query_time_ms": round((time.perf_counter() - t0) * 1000, 2),
    }
