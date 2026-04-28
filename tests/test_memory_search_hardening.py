"""Static checks for retrieval hardening that protect tenant/scope isolation."""

from pathlib import Path


SOURCE = (Path(__file__).resolve().parents[1] / "mcp" / "memory_search.py").read_text()


def test_structured_entity_match_is_tenant_filtered():
    assert "FROM preserve.entity e" in SOURCE
    assert "WHERE e.tenant = %s" in SOURCE


def test_temporal_expansion_accepts_and_applies_scope():
    assert "def _stream_temporal_expand(" in SOURCE
    assert "scope: Optional[str]," in SOURCE
    assert '_scope_clause(scope, "f2.")' in SOURCE
    assert '_scope_clause(scope, "f.")' in SOURCE


def test_memory_results_attach_supported_fact_evidence():
    assert "FROM preserve.memory_support ms" in SOURCE
    assert "JOIN preserve.fact_evidence fe" in SOURCE


def test_graph_stream_is_feature_flagged_and_timeout_bounded():
    assert 'BRAINCORE_GRAPH_RETRIEVAL") == "1"' in SOURCE
    assert "BRAINCORE_GRAPH_STREAM_TIMEOUT_MS" in SOURCE
    assert "set_config('statement_timeout'" in SOURCE


def test_lightweight_reranking_is_feature_flagged_and_deterministic():
    assert 'BRAINCORE_LIGHTWEIGHT_RERANKING") == "1"' in SOURCE
    assert "def _plan_query(" in SOURCE
    assert "PREDICATE_HINTS" in SOURCE
    assert "def _lightweight_rerank_score(" in SOURCE
    assert "def _rank_candidates(" in SOURCE
    assert "if not reranking_enabled:" in SOURCE


def test_graph_stream_preserves_tenant_and_trust_gates():
    assert "WHERE me.tenant = %s" in SOURCE
    assert "me.assertion_class IN (%s, %s, %s)" in SOURCE
    assert "GRAPH_ELIGIBLE_ASSERTION_CLASSES" in SOURCE


def test_graph_stream_degrades_before_migration():
    assert "UndefinedTable" in SOURCE
    assert "except (QueryCanceled, UndefinedTable)" in SOURCE


def test_timeline_reads_event_frames_with_tenant_scope_and_evidence():
    assert "def memory_timeline(" in SOURCE
    assert "FROM preserve.event_frame ef" in SOURCE
    assert '_tenant_clause(TENANT, "ef.")' in SOURCE
    assert '_scope_clause(scope, "ef.")' in SOURCE
    assert "LEFT JOIN preserve.fact_evidence fe" in SOURCE
    assert "fe.fact_id = ef.source_fact_id" in SOURCE
    assert "fe.segment_id = ef.evidence_segment_id" in SOURCE


def test_timeline_bounded_windows_exclude_null_timestamps():
    assert "AND ef.time_start >= %s::timestamptz" in SOURCE
    assert "AND ef.time_start < %s::timestamptz" in SOURCE
    assert "ef.time_start IS NULL OR ef.time_start" not in SOURCE


def test_timeline_degrades_before_event_frame_migration():
    assert "except UndefinedTable:" in SOURCE


def test_before_after_reads_event_frames_with_tenant_scope_and_evidence():
    assert "def memory_before_after(" in SOURCE
    assert "before_sql" in SOURCE
    assert "after_sql" in SOURCE
    assert "ef.time_start < %s::timestamptz" in SOURCE
    assert "ef.time_start >= %s::timestamptz" in SOURCE
    assert '_tenant_clause(TENANT, "ef.")' in SOURCE
    assert '_scope_clause(scope, "ef.")' in SOURCE
    assert "_event_frame_select_sql(include_evidence)" in SOURCE


def test_causal_chain_reads_event_frames_with_tenant_scope_and_evidence():
    assert "def memory_causal_chain(" in SOURCE
    assert "CAUSAL_CHAIN_EVENT_TYPES" in SOURCE
    assert "WITH matching_episodes AS" in SOURCE
    assert "ep.tenant = %s" in SOURCE
    assert "ef.tenant = %s" in SOURCE
    assert '_tenant_clause(TENANT, "ef.")' in SOURCE
    assert '_scope_clause(scope, "ef.")' in SOURCE
    assert "_timeline_time_clause(from_ts, to_ts)" in SOURCE
    assert "_event_frame_select_sql(include_evidence)" in SOURCE
    assert "ef.time_start IS NOT NULL" in SOURCE


def test_procedure_search_reads_procedures_with_tenant_scope():
    assert "def memory_search_procedure(" in SOURCE
    assert "FROM preserve.procedure p" in SOURCE
    assert "LEFT JOIN preserve.procedure_step ps" in SOURCE
    assert "p.tenant = %s" in SOURCE
    assert "ps.tenant = %s" in SOURCE
    assert '_tenant_clause(TENANT, "p.")' in SOURCE
    assert '_scope_clause(scope, "p.")' in SOURCE


def test_visual_search_reads_metadata_without_raw_artifact_paths():
    assert "def memory_search_visual(" in SOURCE
    assert "FROM preserve.visual_region vr" in SOURCE
    assert "JOIN preserve.media_artifact ma" in SOURCE
    assert "ma.tenant = vr.tenant" in SOURCE
    assert "vr.tenant = %s" in SOURCE
    assert "ma.media_meta->>'caption'" in SOURCE
    assert "vr.region_meta->>'ocr_text'" in SOURCE
    assert "original_path" not in SOURCE
