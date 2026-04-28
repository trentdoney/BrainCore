"""BrainCore Memory — Pydantic request/response models for preserve schema."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Shared types
# ---------------------------------------------------------------------------

MemoryObjectType = Literal[
    "fact",
    "memory",
    "segment",
    "episode",
    "procedure",
    "media_artifact",
    "visual_region",
]


# ---------------------------------------------------------------------------
# Evidence sub-model (nested in search results)
# ---------------------------------------------------------------------------

class EvidenceItem(BaseModel):
    segment_id: Optional[str] = None
    excerpt: Optional[str] = None


class GraphPathItem(BaseModel):
    step: str
    object_id: Optional[str] = None
    object_type: Optional[str] = None


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
    include_graph: bool = Field(
        default=False,
        description="Enable feature-flagged graph-path retrieval stream",
    )
    explain_paths: bool = Field(
        default=False,
        description="Include graph/expansion path explanations when available",
    )
    limit: int = Field(default=10, ge=1, le=100)


class MemorySearchResult(BaseModel):
    object_id: str
    object_type: str  # fact, memory, segment, episode, procedure, media_artifact, visual_region
    title: Optional[str] = None
    summary: Optional[str] = None
    confidence: Optional[float] = None
    score: float
    priority: Optional[int] = None
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    evidence: list[EvidenceItem] = Field(default_factory=list)
    why: list[GraphPathItem] = Field(default_factory=list)
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

class MemoryTimelineRequest(BaseModel):
    """Event-frame timeline request for a tenant-bound MCP process."""

    subject: Optional[str] = Field(
        default=None,
        description="Optional entity name filter matched against actor/target/location.",
    )
    scope: Optional[str] = Field(
        default=None,
        description="Scope path prefix filter.",
    )
    event_type: Optional[str] = Field(
        default=None,
        description="Optional event frame type, e.g. cause or remediation.",
    )
    from_ts: Optional[str] = Field(
        default=None,
        description="Inclusive lower bound for frame time_start.",
    )
    to_ts: Optional[str] = Field(
        default=None,
        description="Exclusive upper bound for frame time_start.",
    )
    include_evidence: bool = Field(
        default=True,
        description="Include evidence excerpt metadata when present.",
    )
    limit: int = Field(default=50, ge=1, le=200)


class TimelineEvidence(BaseModel):
    segment_id: Optional[str] = None
    excerpt: Optional[str] = None
    source_relpath: Optional[str] = None
    line_start: Optional[int] = None
    line_end: Optional[int] = None


class TimelineEntry(BaseModel):
    timestamp: Optional[str] = None
    time_end: Optional[str] = None
    event_frame_id: str
    episode_id: str
    source_fact_id: Optional[str] = None
    event_type: str
    actor: Optional[str] = None
    action: str
    target: Optional[str] = None
    location: Optional[str] = None
    object_value: Optional[object] = None
    outcome: Optional[str] = None
    confidence: Optional[float] = None
    assertion_class: Optional[str] = None
    scope_path: Optional[str] = None
    evidence: list[TimelineEvidence] = Field(default_factory=list)


class TimelineResponse(BaseModel):
    subject: Optional[str] = None
    entries: list[TimelineEntry]
    from_ts: Optional[str] = None
    to_ts: Optional[str] = None
    query_time_ms: float


class MemoryBeforeAfterRequest(BaseModel):
    """Nearest event frames before and after a timestamp."""

    timestamp: str = Field(
        description="ISO-8601 timestamp used as the before/after pivot.",
    )
    subject: Optional[str] = Field(
        default=None,
        description="Optional entity name filter matched against actor/target/location.",
    )
    scope: Optional[str] = Field(
        default=None,
        description="Scope path prefix filter.",
    )
    event_type: Optional[str] = Field(
        default=None,
        description="Optional event frame type, e.g. cause or remediation.",
    )
    include_evidence: bool = Field(
        default=True,
        description="Include evidence excerpt metadata when present.",
    )
    limit_each: int = Field(default=3, ge=1, le=50)


class BeforeAfterResponse(BaseModel):
    timestamp: str
    subject: Optional[str] = None
    before: list[TimelineEntry] = Field(default_factory=list)
    after: list[TimelineEntry] = Field(default_factory=list)
    query_time_ms: float


class MemoryCausalChainRequest(BaseModel):
    """Episode-grouped causal chain request."""

    subject: Optional[str] = Field(
        default=None,
        description="Optional entity name filter used to find matching episodes.",
    )
    scope: Optional[str] = Field(
        default=None,
        description="Scope path prefix filter.",
    )
    from_ts: Optional[str] = Field(
        default=None,
        description="Inclusive lower bound for frame time_start.",
    )
    to_ts: Optional[str] = Field(
        default=None,
        description="Exclusive upper bound for frame time_start.",
    )
    include_evidence: bool = Field(
        default=True,
        description="Include evidence excerpt metadata when present.",
    )
    limit: int = Field(default=10, ge=1, le=50)


class CausalChain(BaseModel):
    episode_id: str
    title: Optional[str] = None
    outcome: Optional[str] = None
    scope_path: Optional[str] = None
    steps: list[TimelineEntry] = Field(default_factory=list)


class CausalChainResponse(BaseModel):
    subject: Optional[str] = None
    chains: list[CausalChain] = Field(default_factory=list)
    from_ts: Optional[str] = None
    to_ts: Optional[str] = None
    query_time_ms: float


class MemoryProcedureSearchRequest(BaseModel):
    """Search stored procedure memory."""

    query: str
    scope: Optional[str] = Field(default=None, description="Scope path prefix filter.")
    limit: int = Field(default=10, ge=1, le=50)


class ProcedureStepItem(BaseModel):
    step_index: int
    action: str
    expected_result: Optional[str] = None


class ProcedureSearchResult(BaseModel):
    procedure_id: str
    title: str
    summary: Optional[str] = None
    confidence: Optional[float] = None
    scope_path: Optional[str] = None
    source_fact_id: Optional[str] = None
    steps: list[ProcedureStepItem] = Field(default_factory=list)


class ProcedureSearchResponse(BaseModel):
    query: str
    results: list[ProcedureSearchResult] = Field(default_factory=list)
    query_time_ms: float


class ProcedureOperationalStep(BaseModel):
    procedure_id: str
    procedure_title: str
    procedure_summary: Optional[str] = None
    scope_path: Optional[str] = None
    procedure_source_fact_id: Optional[str] = None
    procedure_evidence_segment_id: Optional[str] = None
    episode_outcome: Optional[str] = None
    step_id: str
    step_index: int
    action: str
    expected_result: Optional[str] = None
    step_source_fact_id: Optional[str] = None
    step_evidence_segment_id: Optional[str] = None
    confidence: Optional[float] = None


class ProcedureOperationalResponse(BaseModel):
    query: str
    results: list[ProcedureOperationalStep] = Field(default_factory=list)
    query_time_ms: float


# ---------------------------------------------------------------------------
# Working-memory endpoint
# ---------------------------------------------------------------------------

class TaskSessionItem(BaseModel):
    session_id: str
    session_key: str
    agent_name: str
    task_title: Optional[str] = None
    status: str
    scope_path: Optional[str] = None
    started_at: str
    last_seen_at: str
    ended_at: Optional[str] = None
    expires_at: Optional[str] = None


class WorkingMemoryItem(BaseModel):
    working_memory_id: str
    session_id: str
    session_key: Optional[str] = None
    memory_kind: str
    content: str
    promotion_status: str
    promotion_reason: Optional[str] = None
    promotion_target_kind: Optional[str] = None
    promotion_target_id: Optional[str] = None
    expires_at: str
    created_at: str


class TaskSessionResponse(BaseModel):
    session: Optional[TaskSessionItem] = None
    query_time_ms: float


class TaskSessionListResponse(BaseModel):
    sessions: list[TaskSessionItem] = Field(default_factory=list)
    query_time_ms: float


class WorkingMemoryResponse(BaseModel):
    item: Optional[WorkingMemoryItem] = None
    query_time_ms: float


class WorkingMemoryListResponse(BaseModel):
    items: list[WorkingMemoryItem] = Field(default_factory=list)
    query_time_ms: float


class WorkingMemoryCleanupResponse(BaseModel):
    expired: int
    query_time_ms: float


# ---------------------------------------------------------------------------
# Visual/multimodal endpoint
# ---------------------------------------------------------------------------

class VisualSearchRequest(BaseModel):
    """Search OCR/caption/layout metadata without returning raw artifacts."""

    query: str
    scope: Optional[str] = Field(default=None, description="Scope path prefix filter")
    media_type: Optional[str] = Field(default=None, description="Optional media type filter")
    limit: int = Field(default=10, ge=1, le=100)


class VisualSearchResult(BaseModel):
    result_type: str
    media_artifact_id: str
    visual_region_id: Optional[str] = None
    media_type: str
    mime_type: Optional[str] = None
    scope_path: Optional[str] = None
    page_number: Optional[int] = None
    region_type: Optional[str] = None
    label: Optional[str] = None
    text: Optional[str] = None
    artifact_id: Optional[str] = None
    source_segment_id: Optional[str] = None
    linked_entity_id: Optional[str] = None
    linked_fact_id: Optional[str] = None
    linked_memory_id: Optional[str] = None
    linked_procedure_id: Optional[str] = None
    bbox: Optional[dict[str, float]] = None
    confidence: Optional[float] = None
    ingest_run_id: Optional[str] = None
    ingest_batch_key: Optional[str] = None


class VisualSearchResponse(BaseModel):
    query: str
    results: list[VisualSearchResult] = Field(default_factory=list)
    query_time_ms: float


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
    model: str = "braincore-minilm-v1"
    dim: int = 384
