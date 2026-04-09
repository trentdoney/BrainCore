"""Strata Memory — 4-stream hybrid retrieval for preserve schema.

Streams:
  1. Structured SQL   — entity name matching -> facts for that entity
  2. Full-text search — plainto_tsquery across fact, memory, segment, episode
  3. Vector search    — cosine similarity on 384-dim embeddings
  4. Temporal/Relation expansion — enrich results with related facts & episodes

Fusion: Reciprocal Rank Fusion with k=60
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .embedder import embed_query

logger = logging.getLogger(__name__)

RRF_K = 60

# Tenant scoping — filter results to the active tenant plus the 'default'
# scope that seed/legacy rows use when no tenant is set.
TENANT = os.environ.get("BRAINCORE_TENANT", "default")


# ---------------------------------------------------------------------------
# Internal candidate model
# ---------------------------------------------------------------------------

@dataclass
class _Candidate:
    object_id: str
    object_type: str  # fact, memory, segment, episode
    title: Optional[str] = None
    summary: Optional[str] = None
    confidence: Optional[float] = None
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    scope_path: Optional[str] = None
    priority: Optional[int] = None
    evidence: list[dict] = field(default_factory=list)


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
    """Build tenant filter — match active tenant OR legacy 'default' rows."""
    col = f"{prefix}tenant"
    return f" AND ({col} = %s OR {col} = 'default')", [tenant]


def _vec_literal(arr) -> str:
    """Convert numpy array to pgvector literal."""
    return "[" + ",".join(f"{x:.8f}" for x in arr) + "]"


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
            FROM preserve.entity
            WHERE canonical_name ILIKE %s
               OR aliases::text ILIKE %s
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
        [like_pattern, like_pattern]
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

def _stream_vector(
    pool: ConnectionPool,
    query: str,
    as_of: Optional[str],
    scope: Optional[str],
    type_filter: Optional[str],
    limit: int,
) -> list[_Candidate]:
    """Embed query, then cosine-similarity search across all 4 tables."""
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
                      {tenant_sql}
                    LIMIT %s
                """
                params = fact_ids + as_of_params + tenant_params + [limit * 2]
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
                      {tenant_sql2}
                    LIMIT %s
                """
                params = (
                    episode_ids
                    + as_of_params2
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
# Evidence lookup (batch)
# ---------------------------------------------------------------------------

def _attach_evidence(
    pool: ConnectionPool,
    candidates: dict[str, _ScoredCandidate],
) -> None:
    """Attach evidence excerpts to fact candidates (in-place)."""
    fact_ids = [
        cid for cid, sc in candidates.items()
        if sc.candidate.object_type == "fact"
    ]
    if not fact_ids:
        return

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
    with pool.connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, fact_ids)
            for r in cur.fetchall():
                fid = r["fact_id"]
                if fid in candidates:
                    candidates[fid].candidate.evidence.append({
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
) -> dict:
    """4-stream hybrid search across the preserve schema.

    Returns a dict suitable for MemorySearchResponse serialization.
    """
    t0 = time.perf_counter()

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
    temporal = _stream_temporal_expand(pool, merged, as_of, limit)
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

    # -- Attach evidence --
    _attach_evidence(pool, merged)

    # -- Sort and truncate --
    ranked = sorted(merged.values(), key=lambda sc: sc.total_score, reverse=True)
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
            "score": round(sc.total_score, 6),
            "priority": c.priority,
            "valid_from": c.valid_from,
            "valid_to": c.valid_to,
            "evidence": [
                {"segment_id": e.get("segment_id"), "excerpt": e.get("excerpt")}
                for e in c.evidence
            ],
            "scope_path": c.scope_path,
        })

    return {
        "results": results,
        "query_time_ms": elapsed_ms,
        "stream_counts": stream_counts,
    }
