"""Reference zero-vector HTTP embedder for BrainCore's retrieval library.

This module implements the embedder contract that ``mcp/memory_search.py``
imports via ``from .embedder import embed_query``. The contract, documented
in ``mcp/README.md``, is a single function:

    embed_query(text: str) -> numpy.ndarray  # shape (384,), dtype float32

Behaviour
---------
1. If ``BRAINCORE_EMBED_URL`` is set, POST ``{"texts": [text]}`` to that
   URL and expect a JSON response of shape ``{"embeddings": [[...]]}``.
   Return the first embedding as a ``numpy.ndarray`` of dtype float32.
2. If the env var is UNSET, or the HTTP call fails for ANY reason (network
   error, non-200 status, malformed JSON, wrong dimension), fall back to a
   384-dimensional zero vector. The vector stream then contributes nothing
   to the RRF fusion, and retrieval degrades gracefully to the remaining
   three streams (structured SQL, full-text, temporal).

The fallback is DELIBERATE: BrainCore must never crash the whole retrieval
pipeline just because the embedding service is down or not configured. A
zero vector is a valid input for ``pgvector`` cosine-distance queries — it
simply returns uniformly low similarity scores, which the RRF fusion step
down-weights naturally.

Production deployments should point ``BRAINCORE_EMBED_URL`` at a real
embedding service that returns 384-dim vectors from the same model family
as the embeddings stored in ``preserve.{fact,memory,segment,episode}``.
The reference model for the public v1.1.4 schema is ``opsvault-minilm-v1``
(384-dim), matching ``mcp/memory_models.py``'s default. Downstream
OpsVault-style deployments typically run their own ``/embed`` HTTP
endpoint in a sibling service.
"""

from __future__ import annotations

import logging
import os

import numpy as np
import requests

logger = logging.getLogger(__name__)

EMBED_DIM = 384
HTTP_TIMEOUT_SECONDS = 30


def _zero_vector() -> np.ndarray:
    """Return a ``(384,) float32`` zero vector."""
    return np.zeros(EMBED_DIM, dtype=np.float32)


def embed_query(text: str) -> np.ndarray:
    """Embed a single query string as a 384-dim float32 ``numpy.ndarray``.

    Reads ``BRAINCORE_EMBED_URL`` from the environment. There is NO
    baked-in default URL — if the env var is unset, ``embed_query``
    returns a 384-dim zero vector immediately, and the retrieval
    pipeline's vector stream degrades gracefully to the remaining three
    streams (structured SQL, full-text, temporal). The HTTP call is
    only attempted when the env var is explicitly set to a non-empty
    value. If the HTTP call is attempted and fails for any reason
    (network error, non-200 status, malformed JSON, wrong dimension),
    the function falls back to the same zero vector rather than
    crashing retrieval.
    """
    url = os.environ.get("BRAINCORE_EMBED_URL")
    if not url:
        logger.debug("BRAINCORE_EMBED_URL unset; returning zero vector")
        return _zero_vector()

    try:
        resp = requests.post(
            url,
            json={"texts": [text]},
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        if resp.status_code != 200:
            logger.warning(
                "Embedder HTTP %s at %s; falling back to zero vector",
                resp.status_code,
                url,
            )
            return _zero_vector()
        payload = resp.json()
        embeddings = payload.get("embeddings")
        if not embeddings or not embeddings[0]:
            logger.warning("Embedder payload missing 'embeddings'; zero vector")
            return _zero_vector()
        vec = np.asarray(embeddings[0], dtype=np.float32)
        if vec.shape != (EMBED_DIM,):
            logger.warning(
                "Embedder returned shape %s; expected (%d,); zero vector",
                vec.shape,
                EMBED_DIM,
            )
            return _zero_vector()
        return vec
    except Exception as exc:  # noqa: BLE001 — defensive: any failure -> fallback
        logger.warning("Embedder call failed (%s); zero vector", exc)
        return _zero_vector()
