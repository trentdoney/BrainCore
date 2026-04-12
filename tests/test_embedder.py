"""Tests for the BrainCore retrieval embedder."""

import numpy as np

from mcp import embedder


class _Response:
    status_code = 200

    def json(self):
        return {"embeddings": [[0.25] * embedder.EMBED_DIM]}


def test_embed_query_sends_bearer_token(monkeypatch):
    captured = {}

    monkeypatch.setenv("BRAINCORE_EMBED_URL", "http://embed.test/embed")
    monkeypatch.setenv("BRAINCORE_EMBED_AUTH_TOKEN", "test-token")

    def fake_post(url, json, timeout, headers):
        captured.update(
            {
                "url": url,
                "json": json,
                "timeout": timeout,
                "headers": headers,
            }
        )
        return _Response()

    monkeypatch.setattr(embedder.requests, "post", fake_post)

    vec = embedder.embed_query("hello")

    assert captured["url"] == "http://embed.test/embed"
    assert captured["json"] == {"texts": ["hello"]}
    assert captured["headers"] == {"Authorization": "Bearer test-token"}
    assert vec.shape == (embedder.EMBED_DIM,)
    assert vec.dtype == np.float32
    assert float(vec[0]) == 0.25


def test_embed_query_omits_auth_header_when_token_unset(monkeypatch):
    captured = {}
    monkeypatch.setenv("BRAINCORE_EMBED_URL", "http://embed.test/embed")
    monkeypatch.delenv("BRAINCORE_EMBED_AUTH_TOKEN", raising=False)

    def fake_post(url, json, timeout, headers):
        captured["headers"] = headers
        return _Response()

    monkeypatch.setattr(embedder.requests, "post", fake_post)

    assert embedder.embed_query("hello").shape == (embedder.EMBED_DIM,)
    assert captured["headers"] == {}
