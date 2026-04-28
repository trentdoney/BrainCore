"""BrainCore retrieval library — Python-side memory search over the preserve schema.

This is a library, not a server. It provides a single public entry point,
``memory_search.memory_search()``, which runs four core retrieval streams
(structured SQL + full-text + vector + temporal expansion) plus optional
graph-path retrieval fused with Reciprocal Rank Fusion against the
``preserve`` schema. See
``examples/mcp_server/`` for a runnable FastMCP reference server built on
top of this library.
"""
