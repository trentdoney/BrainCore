"""Static hardening checks for BrainCore memory governance retrieval."""

from pathlib import Path
import unittest
from unittest.mock import patch

import mcp.memory_search as ms

ROOT = Path(__file__).resolve().parents[1]
MODELS = (ROOT / "mcp" / "memory_models.py").read_text()
SEARCH = (ROOT / "mcp" / "memory_search.py").read_text()


class FakeCursor:
    def __init__(self, responses):
        self.responses = list(responses)
        self.executions = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params):
        self.executions.append((sql, params))

    def fetchall(self):
        return self.responses.pop(0)


class FakeConnection:
    def __init__(self, cursor):
        self.cursor_obj = cursor

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def cursor(self, row_factory=None):  # noqa: ARG002
        return self.cursor_obj


class FakePool:
    def __init__(self, responses):
        self.cursor_obj = FakeCursor(responses)

    def connection(self):
        return FakeConnection(self.cursor_obj)


class MemorySearchGovernanceTests(unittest.TestCase):
    def test_search_request_excludes_governed_memories_by_default(self):
        self.assertIn("include_excluded: bool", MODELS)
        self.assertIn("default=False", MODELS)
        self.assertIn("archived,", MODELS)
        self.assertIn("quarantined,", MODELS)
        self.assertIn("suppressed,", MODELS)
        self.assertIn("retired", MODELS)

    def test_memory_search_filters_non_prompt_memory_by_default(self):
        self.assertIn("EXCLUDED_MEMORY_GOVERNANCE_STATUSES", SEARCH)
        self.assertIn("archived", SEARCH)
        self.assertIn("quarantined", SEARCH)
        self.assertIn("suppressed", SEARCH)
        self.assertIn("retired", SEARCH)
        self.assertIn("retired_superseded", SEARCH)
        self.assertIn("NOT IN", SEARCH)
        self.assertIn("_memory_governance_clause(include_excluded", SEARCH)
        self.assertIn("_related_memory_governance_clause(include_excluded", SEARCH)
        self.assertIn("preserve.memory_support", SEARCH)

    def test_memory_search_can_report_governance_metadata(self):
        self.assertIn("namespace: Optional[str]", MODELS)
        self.assertIn("governance_status: Optional[str]", MODELS)
        self.assertIn("token_count: Optional[int]", MODELS)
        self.assertIn("trust_class: Optional[str]", MODELS)
        self.assertIn('"namespace": c.namespace', SEARCH)
        self.assertIn('"governance_status": c.governance_status', SEARCH)
        self.assertIn('"token_count": c.token_count', SEARCH)
        self.assertIn('"trust_class": c.trust_class', SEARCH)

    def test_related_governance_clause_targets_non_memory_rows(self):
        segment_sql, segment_params = ms._related_memory_governance_clause(False, "segment", "s.")  # noqa: SLF001
        self.assertIn("NOT EXISTS", segment_sql)
        self.assertIn("preserve.memory_support", segment_sql)
        self.assertIn("preserve.fact_evidence", segment_sql)
        self.assertIn("preserve.event", segment_sql)
        self.assertIn("preserve.episode", segment_sql)
        self.assertIn("gfe.segment_id = s.segment_id", segment_sql)
        self.assertIn("gep.primary_artifact_id = s.artifact_id", segment_sql)
        for value in ms.EXCLUDED_MEMORY_GOVERNANCE_STATUSES + ms.EXCLUDED_MEMORY_TRUST_CLASSES:
            self.assertIn(value, segment_params)

        fact_sql, _ = ms._related_memory_governance_clause(False, "fact", "f.")  # noqa: SLF001
        self.assertIn("gms.fact_id = f.fact_id", fact_sql)
        self.assertIn("gms.episode_id = f.episode_id", fact_sql)

        disabled_sql, disabled_params = ms._related_memory_governance_clause(True, "segment", "s.")  # noqa: SLF001
        self.assertEqual("", disabled_sql)
        self.assertEqual([], disabled_params)

    def test_fts_segment_stream_enforces_related_governance_by_default(self):
        pool = FakePool([[]])
        results = ms._stream_fts(  # noqa: SLF001
            pool,
            "operator secret",
            as_of=None,
            scope="project:braincore",
            type_filter="segment",
            limit=5,
        )

        self.assertEqual([], results)
        sql, params = pool.cursor_obj.executions[0]
        self.assertIn("FROM preserve.segment s", sql)
        self.assertIn("NOT EXISTS", sql)
        self.assertIn("preserve.memory_support", sql)
        self.assertIn("preserve.fact_evidence", sql)
        for value in ms.EXCLUDED_MEMORY_GOVERNANCE_STATUSES + ms.EXCLUDED_MEMORY_TRUST_CLASSES:
            self.assertIn(value, params)

    def test_operator_override_disables_related_governance_clause(self):
        pool = FakePool([[]])
        ms._stream_fts(  # noqa: SLF001
            pool,
            "operator secret",
            as_of=None,
            scope="project:braincore",
            type_filter="segment",
            limit=5,
            include_excluded=True,
        )

        sql, params = pool.cursor_obj.executions[0]
        self.assertIn("FROM preserve.segment s", sql)
        self.assertNotIn("preserve.memory_support", sql)
        self.assertNotIn("archived", params)
        self.assertNotIn("retired_superseded", params)

    def test_structured_fact_stream_enforces_related_governance_by_default(self):
        pool = FakePool([[]])
        results = ms._stream_structured(  # noqa: SLF001
            pool,
            "braincore",
            as_of=None,
            scope="project:braincore",
            type_filter="fact",
            limit=5,
        )

        self.assertEqual([], results)
        sql, params = pool.cursor_obj.executions[0]
        self.assertIn("FROM preserve.fact f", sql)
        self.assertIn("preserve.memory_support", sql)
        self.assertIn("gms.fact_id = f.fact_id", sql)
        for value in ms.EXCLUDED_MEMORY_GOVERNANCE_STATUSES + ms.EXCLUDED_MEMORY_TRUST_CLASSES:
            self.assertIn(value, params)

    def test_vector_segment_stream_enforces_related_governance_by_default(self):
        with patch.object(ms, "EMBEDDING_INDEX_RETRIEVAL_ENABLED", False), patch.object(ms, "embed_query", lambda _query: [0.25] * 384):
            pool = FakePool([[]])
            results = ms._stream_vector(  # noqa: SLF001
                pool,
                "operator secret",
                as_of=None,
                scope="project:braincore",
                type_filter="segment",
                limit=5,
            )

        self.assertEqual([], results)
        sql, params = pool.cursor_obj.executions[0]
        self.assertIn("FROM preserve.segment s", sql)
        self.assertIn("preserve.memory_support", sql)
        for value in ms.EXCLUDED_MEMORY_GOVERNANCE_STATUSES + ms.EXCLUDED_MEMORY_TRUST_CLASSES:
            self.assertIn(value, params)

    def test_embedding_index_segment_stream_enforces_related_governance_by_default(self):
        with patch.object(ms, "EMBEDDING_INDEX_RETRIEVAL_ENABLED", True), patch.object(ms, "embed_query", lambda _query: [0.25] * 384):
            pool = FakePool([[]])
            results = ms._stream_vector(  # noqa: SLF001
                pool,
                "operator secret",
                as_of=None,
                scope="project:braincore",
                type_filter="segment",
                limit=5,
            )

        self.assertEqual([], results)
        sql, params = pool.cursor_obj.executions[0]
        self.assertIn("FROM preserve.embedding_index ei", sql)
        self.assertIn("JOIN preserve.segment s", sql)
        self.assertIn("preserve.memory_support", sql)
        for value in ms.EXCLUDED_MEMORY_GOVERNANCE_STATUSES + ms.EXCLUDED_MEMORY_TRUST_CLASSES:
            self.assertIn(value, params)


if __name__ == "__main__":
    unittest.main()
