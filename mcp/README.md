# BrainCore MCP Layer

Python-based retrieval layer for the BrainCore knowledge graph. Provides
four core retrieval streams (SQL + FTS + vector + temporal) plus optional
graph-path retrieval with Reciprocal Rank Fusion.

## Files

- `memory_models.py` — Pydantic request/response models
- `memory_search.py` — hybrid retrieval engine

## Dependencies

```bash
pip install -r requirements.txt
```

## Integration

These modules are designed to be imported into your MCP server
implementation. The `memory_search()` function takes a
`psycopg_pool.ConnectionPool` and returns search results ready for MCP
tool responses.

Tenant contract:

- Run one MCP process per tenant.
- `BRAINCORE_TENANT` fixes the tenant for that process.
- Search is exact-tenant: each process reads only rows for its configured tenant.
- Tenant isolation is enforced by application query filters and
  tenant-scoped constraints. BrainCore does not claim PostgreSQL RLS
  isolation unless a deployment adds and verifies RLS policies.

Network wrapper contract:

- The repo ships library code and a stdio example, not a hardened remote
  network service.
- HTTP, SSE, WebSocket, or remote MCP wrappers must authenticate clients
  before tool access.
- Bind wrappers to localhost or a trusted private network by default.
- Apply request timeouts, rate limits, and maximum `limit` values.
- Validate `query`, `scope`, `type_filter`, and `as_of` before passing
  them into retrieval.
- Do not expose raw artifacts or full segment text unless that tool has
  a separate privacy review.
- Use a read-only database role for retrieval wrappers where possible.

```python
from mcp.memory_search import memory_search

results = memory_search(
    pool=your_connection_pool,
    query="docker restart loop",
    as_of="2026-03-15T00:00:00Z",
    scope="device:server-a",
    limit=10,
)
```

## Embedding Dependency

The vector search stream requires an `embedder` module that provides
`embed_query(text) -> numpy.array`. The bundled `embedder.py` implements
the default contract:

- If `BRAINCORE_EMBED_URL` is unset, return a 384-dimensional zero
  vector and let SQL, FTS, and temporal streams carry retrieval.
- If `BRAINCORE_EMBED_URL` is set, POST `{"texts": [text]}` to that URL.
  Configure only a trusted endpoint because raw query text is sent to the
  embedder.
- If `BRAINCORE_EMBED_AUTH_TOKEN` is set, send it as a bearer token.
- On network errors, non-200 responses, malformed JSON, or wrong vector
  shape, fall back to the same zero vector.

You can replace it with your own embedding service implementation:

```python
# embedder.py
import requests
import numpy as np

EMBED_URL = "http://localhost:8900/embed"

def embed_query(text: str) -> np.ndarray:
    resp = requests.post(EMBED_URL, json={"texts": [text]}, timeout=30)
    resp.raise_for_status()
    return np.array(resp.json()["embeddings"][0], dtype=np.float32)
```

This fallback is intentional. Retrieval should degrade without vector
contribution rather than crash the MCP tool because an embedding service
is missing or unhealthy.

By default, MCP vector retrieval uses the legacy `embedding` columns on
preserve tables. Set `BRAINCORE_EMBEDDING_INDEX_RETRIEVAL=1` to route
fact evidence and segment text vector search through the role-specific
`preserve.embedding_index` rows populated by `scripts/backfill-embeddings.py
--embedding-index`. Leave the flag unset for the legacy fallback path.
