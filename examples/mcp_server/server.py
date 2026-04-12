"""Example stdio MCP server for BrainCore.

This is a minimal reference implementation showing how to expose the
BrainCore retrieval library (``mcp/memory_search.py``) over the Model
Context Protocol using FastMCP's stdio transport.

It registers exactly one tool, ``memory-search``, wired directly to the
single public function the retrieval library exports today
(``memory_search``). Downstream deployments that need additional tools
(state-at, timeline, explain, embed, and so on) should build those on
top of the same library in their own server.

Two design notes worth understanding before extending this file:

1. **Namespace loading.** BrainCore's retrieval library lives in a
   top-level directory named ``mcp/`` at the repo root. That name
   collides with the PyPI ``mcp`` package that provides FastMCP. When
   Python is started from the repo root, the local ``mcp/`` directory
   shadows the installed FastMCP package and ``from mcp.server.fastmcp
   import FastMCP`` raises ``ModuleNotFoundError: No module named
   'mcp.server'``. To avoid that, this module loads BrainCore's library
   files via ``importlib.util.spec_from_file_location`` under a
   synthetic package name (``braincore_lib``). FastMCP continues to
   import from the PyPI ``mcp`` package untouched.

2. **Lazy pool creation.** The psycopg connection pool is created on
   the first tool call, not at import time. That keeps this module
   importable in environments where ``BRAINCORE_POSTGRES_DSN`` is not
   set (CI import checks, linters, MCP tool introspection). Real tool
   calls against an unconfigured server raise a clear ``RuntimeError``.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Neutralize the repo-root ``mcp/`` namespace collision BEFORE importing
# FastMCP. See the module docstring for background. If the current working
# directory contains an ``mcp/`` directory (the BrainCore retrieval library
# location), strip cwd from ``sys.path`` so the PyPI ``mcp`` package (which
# provides FastMCP) resolves instead of the local directory. This must run
# before any ``import mcp...`` statement in this file.
_cwd = os.getcwd()
if os.path.isdir(os.path.join(_cwd, "mcp")):
    sys.path[:] = [p for p in sys.path if p not in ("", _cwd)]

from mcp.server.fastmcp import FastMCP  # noqa: E402
from psycopg_pool import ConnectionPool  # noqa: E402

# ---------------------------------------------------------------------------
# Locate and load BrainCore's retrieval library under a synthetic package
# name so we do not shadow the PyPI ``mcp`` package (which provides
# FastMCP). The library lives at ``<repo_root>/mcp/`` relative to this
# file: ``examples/mcp_server/server.py`` -> ``../../mcp/``.
# ---------------------------------------------------------------------------

_LIB_DIR = (Path(__file__).resolve().parent / ".." / ".." / "mcp").resolve()
_SYNTH_PKG = "braincore_lib"


def _load_module(module_name: str, file_path: Path) -> types.ModuleType:
    """Load a single BrainCore library file under the synthetic package."""
    spec = importlib.util.spec_from_file_location(
        f"{_SYNTH_PKG}.{module_name}",
        file_path,
    )
    if spec is None or spec.loader is None:
        raise ImportError(
            f"Could not create spec for {file_path}. "
            f"Expected BrainCore retrieval library at {_LIB_DIR}."
        )
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"{_SYNTH_PKG}.{module_name}"] = module
    spec.loader.exec_module(module)
    return module


def _bootstrap_library() -> tuple[Any, Any, Any]:
    """Install the synthetic package and load memory_models, embedder,
    memory_search. Returns (memory_search, MemorySearchRequest, MemorySearchResponse).

    If ``<repo_root>/mcp/embedder.py`` is missing (a known gap in the
    public BrainCore repo today), install a zero-vector stub so the
    library can be imported. Vector-stream retrieval will return no
    candidates until a real embedder is provided; FTS, structured, and
    temporal streams continue to work.
    """
    if not _LIB_DIR.is_dir():
        raise RuntimeError(
            f"BrainCore retrieval library not found at {_LIB_DIR}. "
            f"This example expects to be run from within a BrainCore "
            f"checkout at examples/mcp_server/."
        )

    # Register the synthetic parent package.
    if _SYNTH_PKG not in sys.modules:
        pkg = types.ModuleType(_SYNTH_PKG)
        pkg.__path__ = [str(_LIB_DIR)]  # type: ignore[attr-defined]
        sys.modules[_SYNTH_PKG] = pkg

    # memory_models has no internal dependencies, load it first.
    mm = _load_module("memory_models", _LIB_DIR / "memory_models.py")

    # embedder is a dependency of memory_search. Use the repo copy if
    # present, otherwise install a zero-vector stub.
    embedder_path = _LIB_DIR / "embedder.py"
    if embedder_path.is_file():
        _load_module("embedder", embedder_path)
    else:
        import numpy as np  # local import to keep module-top-level light

        stub = types.ModuleType(f"{_SYNTH_PKG}.embedder")

        def embed_query(text: str):  # noqa: ARG001  # signature match
            return np.zeros(384, dtype=np.float32)

        stub.embed_query = embed_query  # type: ignore[attr-defined]
        sys.modules[f"{_SYNTH_PKG}.embedder"] = stub

    ms = _load_module("memory_search", _LIB_DIR / "memory_search.py")

    return ms.memory_search, mm.MemorySearchRequest, mm.MemorySearchResponse


_memory_search, MemorySearchRequest, MemorySearchResponse = _bootstrap_library()


# ---------------------------------------------------------------------------
# FastMCP app (instantiated at module scope so CI can introspect it
# without touching the database).
# ---------------------------------------------------------------------------

app = FastMCP("braincore-example-mcp")

# Deferred connection pool. Created on first tool invocation.
_pool: Optional[ConnectionPool] = None


def _get_pool() -> ConnectionPool:
    """Return the process-wide psycopg connection pool.

    Creates the pool on first call. Raises ``RuntimeError`` with a clear
    remediation message if ``BRAINCORE_POSTGRES_DSN`` is not set.

    Deferring pool construction is intentional: it lets ``server.py`` be
    imported in environments without a database (CI import checks,
    linters, MCP tool introspection) while still failing loudly when a
    real tool call is attempted against an unconfigured server.
    """
    global _pool
    if _pool is not None:
        return _pool

    dsn = os.environ.get("BRAINCORE_POSTGRES_DSN")
    if not dsn:
        raise RuntimeError(
            "BRAINCORE_POSTGRES_DSN is not set. Export it to a libpq DSN "
            "pointing at a BrainCore preserve-schema database, for example:\n"
            "  export BRAINCORE_POSTGRES_DSN='<libpq DSN>'\n"
            "The target database must have migrations 001-010 applied."
        )

    _pool = ConnectionPool(conninfo=dsn, min_size=1, max_size=4, open=True)
    return _pool


@app.tool(name="memory-search")
def memory_search_tool(
    query: str,
    limit: int = 10,
    type_filter: Optional[str] = None,
    as_of: Optional[str] = None,
    scope: Optional[str] = None,
) -> dict[str, Any]:
    """4-stream hybrid retrieval (SQL + FTS + vector + temporal, fused with RRF) over the preserve schema. Returns facts, memories, segments, and episodes.

    Args:
        query: Natural-language search string.
        limit: Maximum number of results to return (1-100, default 10).
        type_filter: Optional object-type filter. One of
            ``fact``, ``memory``, ``segment``, ``episode``.
        as_of: Optional ISO-8601 timestamp for temporal filtering
            (default: current time).
        scope: Optional scope-path prefix filter
            (for example, ``device:server-a``).

    Returns:
        A JSON-serializable dict with three keys:

        - ``results``: list of result objects (``object_id``,
          ``object_type``, ``title``, ``summary``, ``confidence``,
          ``score``, ``valid_from``, ``valid_to``, ``evidence``,
          ``scope_path``).
        - ``query_time_ms``: float, end-to-end query latency.
        - ``stream_counts``: dict of candidate counts per retrieval stream
          (``structured``, ``fts``, ``vector``, ``temporal``).
    """
    # Validate inputs through the Pydantic request model so the tool
    # exposes the same contract as the rest of the retrieval library.
    request = MemorySearchRequest(
        query=query,
        limit=limit,
        type_filter=type_filter,  # type: ignore[arg-type]
        as_of=as_of,
        scope=scope,
    )

    pool = _get_pool()
    raw = _memory_search(
        pool,
        query=request.query,
        as_of=request.as_of,
        scope=request.scope,
        type_filter=request.type_filter,
        limit=request.limit,
    )

    # Round-trip through the response model for shape validation and to
    # guarantee JSON-safe primitive types in the returned dict.
    response = MemorySearchResponse.model_validate(raw)
    return response.model_dump(mode="json")


if __name__ == "__main__":
    # stdio transport — connect from Claude Desktop or MCP Inspector.
    app.run()
