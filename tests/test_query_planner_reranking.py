from mcp import memory_search as ms


def test_query_planner_extracts_deterministic_hints():
    plan = ms._plan_query(  # noqa: SLF001
        "How did we fix xrdp on device:alpha after 2026-03-15?",
        "device:alpha",
    )

    assert plan.desired_answer_type == "procedure"
    assert "xrdp" in plan.entities
    assert "device:alpha" in plan.scope_hints
    assert "remediation" in plan.predicate_hints
    assert "2026-03-15" in plan.time_hints


def test_disabled_reranking_preserves_fixed_rrf_order():
    strong_rrf = ms._ScoredCandidate(  # noqa: SLF001
        candidate=ms._Candidate(  # noqa: SLF001
            object_id="a",
            object_type="fact",
            title="generic result",
            scope_path="device:other",
        ),
        scores={"fts": 0.05},
    )
    matching_lower_rrf = ms._ScoredCandidate(  # noqa: SLF001
        candidate=ms._Candidate(  # noqa: SLF001
            object_id="b",
            object_type="memory",
            title="Playbook: xrdp fix",
            summary="Fix xrdp session handling",
            scope_path="device:alpha",
            confidence=0.95,
            evidence=[{"segment_id": "s1"}],
        ),
        scores={"fts": 0.04},
    )
    plan = ms._plan_query("how did we fix xrdp on device:alpha", "device:alpha")  # noqa: SLF001

    ranked = ms._rank_candidates([matching_lower_rrf, strong_rrf], plan, False)  # noqa: SLF001

    assert [item.candidate.object_id for item in ranked] == ["a", "b"]


def test_enabled_lightweight_reranking_uses_existing_signals():
    strong_rrf = ms._ScoredCandidate(  # noqa: SLF001
        candidate=ms._Candidate(  # noqa: SLF001
            object_id="a",
            object_type="fact",
            title="generic result",
            scope_path="device:other",
        ),
        scores={"fts": 0.05},
    )
    matching_lower_rrf = ms._ScoredCandidate(  # noqa: SLF001
        candidate=ms._Candidate(  # noqa: SLF001
            object_id="b",
            object_type="memory",
            title="Playbook: xrdp fix",
            summary="Fix xrdp session handling",
            scope_path="device:alpha",
            confidence=0.95,
            evidence=[{"segment_id": "s1"}, {"segment_id": "s2"}],
        ),
        scores={"fts": 0.04, "graph": 0.01},
    )
    plan = ms._plan_query("how did we fix xrdp on device:alpha", "device:alpha")  # noqa: SLF001

    ranked = ms._rank_candidates([strong_rrf, matching_lower_rrf], plan, True)  # noqa: SLF001

    assert [item.candidate.object_id for item in ranked] == ["b", "a"]
    assert (
        ms._display_score(matching_lower_rrf, plan, True)  # noqa: SLF001
        > matching_lower_rrf.total_score
    )
