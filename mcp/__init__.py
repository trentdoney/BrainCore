"""BrainCore retrieval library — Python-side memory search over the preserve schema.

This is a library, not a server. It provides a single public entry point,
``memory_search.memory_search()``, which runs a 4-stream hybrid retrieval
(structured SQL + full-text + vector + temporal expansion) fused with
Reciprocal Rank Fusion against the ``preserve`` schema. See
``examples/mcp_server/`` for a runnable FastMCP reference server built on
top of this library.
"""
