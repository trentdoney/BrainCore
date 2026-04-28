"""Verify the mcp library loads without errors."""


def test_memory_search_module_imports():
    from mcp import memory_search
    assert callable(memory_search.memory_search)
    assert callable(memory_search.memory_timeline)
    assert callable(memory_search.memory_before_after)


def test_memory_models_imports():
    from mcp import memory_models
    assert hasattr(memory_models, "MemorySearchRequest")
    assert hasattr(memory_models, "MemorySearchResponse")
    assert hasattr(memory_models, "MemoryTimelineRequest")
    assert hasattr(memory_models, "TimelineResponse")
    assert hasattr(memory_models, "MemoryBeforeAfterRequest")
    assert hasattr(memory_models, "BeforeAfterResponse")
