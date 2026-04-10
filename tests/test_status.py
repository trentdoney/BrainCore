"""Verify the mcp library loads without errors."""


def test_memory_search_module_imports():
    from mcp import memory_search
    assert callable(memory_search.memory_search)


def test_memory_models_imports():
    from mcp import memory_models
    assert hasattr(memory_models, "MemorySearchRequest")
    assert hasattr(memory_models, "MemorySearchResponse")
