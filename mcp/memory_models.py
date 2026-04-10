"""BrainCore Memory — Pydantic request/response models for preserve schema."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Shared types
# ---------------------------------------------------------------------------

MemoryObjectType = Literal["fact", "memory", "segment", "episode"]


# ---------------------------------------------------------------------------
# Evidence sub-model (nested in search results)
# ---------------------------------------------------------------------------

class EvidenceItem(BaseModel):
    segment_id: Optional[str] = None
    excerpt: Optional[str] = None


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

class MemorySearchRequest(BaseModel):
    """Search request for a tenant-bound MCP process.

    The tenant is fixed by BRAINCORE_TENANT at process start. Searches are
    exact-tenant and only read rows for that configured tenant.
    """

    query: str
    as_of: Optional[str] = Field(
        default=None,
        description="ISO-8601 timestamp for temporal filtering (default: now)",
    )
    scope: Optional[str] = Field(
        default=None,
        description="Scope path prefix filter (e.g. 'device:server-a')",
    )
    type_filter: Optional[MemoryObjectType] = Field(
        default=None,
        description="Restrict results to a single object type",
    )
    limit: int = Field(default=10, ge=1, le=100)


class MemorySearchResult(BaseModel):
    object_id: str
    object_type: str  # fact, memory, segment, episode
    title: Optional[str] = None
    summary: Optional[str] = None
    confidence: Optional[float] = None
    score: float
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    evidence: list[EvidenceItem] = Field(default_factory=list)
    scope_path: Optional[str] = None


class MemorySearchResponse(BaseModel):
    results: list[MemorySearchResult]
    query_time_ms: float
    stream_counts: dict[str, int] = Field(
        default_factory=dict,
        description="Candidate counts per retrieval stream",
    )


# ---------------------------------------------------------------------------
# State-at endpoint
# ---------------------------------------------------------------------------

class FactStateItem(BaseModel):
    fact_id: str
    predicate: str
    object_value: Optional[str] = None
    object_entity: Optional[str] = None
    confidence: float
    assertion_class: str
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    fact_kind: str
    scope_path: Optional[str] = None


class EntityStateResponse(BaseModel):
    entity: str
    entity_id: Optional[str] = None
    as_of: Optional[str] = None
    facts: list[FactStateItem]


# ---------------------------------------------------------------------------
# Timeline endpoint
# ---------------------------------------------------------------------------

class TimelineEntry(BaseModel):
    timestamp: Optional[str] = None
    entry_type: str  # fact, event
    entry_id: str
    description: str
    confidence: Optional[float] = None
    meta: Optional[dict] = None


class TimelineResponse(BaseModel):
    subject: str
    entries: list[TimelineEntry]
    from_ts: Optional[str] = None
    to_ts: Optional[str] = None


# ---------------------------------------------------------------------------
# Explain endpoint
# ---------------------------------------------------------------------------

class ProvenanceLink(BaseModel):
    link_type: str  # evidence, support, episode, archive
    linked_id: str
    linked_type: str
    excerpt: Optional[str] = None
    notes: Optional[str] = None


class ExplainResponse(BaseModel):
    object_id: str
    object_type: str
    title: Optional[str] = None
    summary: Optional[str] = None
    confidence: Optional[float] = None
    provenance: list[ProvenanceLink] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Embed endpoint
# ---------------------------------------------------------------------------

class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=64)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    model: str = "opsvault-minilm-v1"
    dim: int = 384
