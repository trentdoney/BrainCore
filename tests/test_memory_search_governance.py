"""Static hardening checks for BrainCore memory governance retrieval."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODELS = (ROOT / "mcp" / "memory_models.py").read_text()
SEARCH = (ROOT / "mcp" / "memory_search.py").read_text()


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

    def test_memory_search_can_report_governance_metadata(self):
        self.assertIn("namespace: Optional[str]", MODELS)
        self.assertIn("governance_status: Optional[str]", MODELS)
        self.assertIn("token_count: Optional[int]", MODELS)
        self.assertIn("trust_class: Optional[str]", MODELS)
        self.assertIn('"namespace": c.namespace', SEARCH)
        self.assertIn('"governance_status": c.governance_status', SEARCH)
        self.assertIn('"token_count": c.token_count', SEARCH)
        self.assertIn('"trust_class": c.trust_class', SEARCH)


if __name__ == "__main__":
    unittest.main()
