# BrainCore MCP Layer

Python-based retrieval layer for the BrainCore knowledge graph. Provides 4-stream hybrid search (SQL + FTS + vector + temporal) with Reciprocal Rank Fusion.

## Files

- `memory_models.py` — Pydantic request/response models
- `memory_search.py` — 4-stream hybrid retrieval engine

## Dependencies

```bash
pip install -r requirements.txt
```

## Integration

These modules are designed to be imported into your MCP server implementation. The `memory_search()` function takes a `psycopg_pool.ConnectionPool` and returns search results ready for MCP tool responses.

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

The vector search stream requires an `embedder` module that provides `embed_query(text) -> numpy.array`. You'll need to implement this based on your embedding service:

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
