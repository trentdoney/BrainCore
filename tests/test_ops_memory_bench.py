import importlib.util
import sys
from pathlib import Path


BENCHMARKS_DIR = Path(__file__).resolve().parents[1] / "benchmarks"
RUNNER_PATH = BENCHMARKS_DIR / "run_ops_memory_bench.py"


def load_runner():
    sys.path.insert(0, str(BENCHMARKS_DIR))
    spec = importlib.util.spec_from_file_location("run_ops_memory_bench", RUNNER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_ordered_subset_requires_sequence_order():
    runner = load_runner()

    assert runner.ordered_subset(["a", "x", "b", "c"], ["a", "b", "c"])
    assert not runner.ordered_subset(["b", "a", "c"], ["a", "b", "c"])


def test_graph_path_detection_requires_memory_edge_step():
    runner = load_runner()

    results = [
        {"object_id": "target", "why": [{"object_type": "memory_edge"}]},
        {"object_id": "other", "why": []},
    ]

    assert runner.has_graph_path(results, "target")
    assert not runner.has_graph_path(results, "other")


def test_scope_leak_detection_checks_scope_and_forbidden_ids():
    runner = load_runner()

    results = [
        {"object_id": "allowed", "scope_path": "device:server-a"},
        {"object_id": "forbidden-id", "scope_path": "device:server-a"},
        {"object_id": "other", "scope_path": "device:server-b/incidents/INC-002"},
    ]

    assert runner.count_scope_leaks(
        results,
        forbidden_scope_prefix="device:server-b",
        forbidden_object_ids=["forbidden-id"],
    ) == 2


def test_procedure_schema_state_reports_absent_without_tables(monkeypatch):
    runner = load_runner()

    class Cursor:
        def execute(self, *args, **kwargs):
            pass

        def fetchall(self):
            return []

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class Connection:
        def cursor(self):
            return Cursor()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(runner.psycopg, "connect", lambda dsn: Connection())

    state = runner.procedure_schema_state("dummy-dsn")

    assert state["status"] == "schema_absent_placeholder"
    assert not state["scored"]


def test_procedure_schema_state_scores_when_tables_exist(monkeypatch):
    runner = load_runner()

    class Cursor:
        def execute(self, *args, **kwargs):
            pass

        def fetchall(self):
            return [("procedure",), ("procedure_step",)]

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class Connection:
        def cursor(self):
            return Cursor()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(runner.psycopg, "connect", lambda dsn: Connection())

    state = runner.procedure_schema_state("dummy-dsn")

    assert state["status"] == "schema_present_scored"
    assert state["scored"]
    assert len(state["cases"]) == 2


def test_procedure_operational_cases_cover_expected_tools():
    runner = load_runner()

    assert [case["tool"] for case in runner.PROCEDURE_OPERATIONAL_CASES] == [
        "next_step",
        "tried_before",
        "failed_remediation",
    ]
    assert all(case["expected_step_id"] for case in runner.PROCEDURE_OPERATIONAL_CASES)


def test_reranking_synthetic_scores_expected_orders():
    runner = load_runner()

    reports = runner.score_reranking_synthetic()

    assert reports == [
        {
            "id": "reranking-procedure-answer-boost",
            "query": "how did we fix xrdp on device:alpha",
            "disabled_order": ["a", "b"],
            "enabled_order": ["b", "a"],
            "hit": True,
        }
    ]


def test_multimodal_cases_cover_metadata_and_vector_paths():
    runner = load_runner()

    assert [case["expected_result_type"] for case in runner.MULTIMODAL_METADATA_CASES] == [
        "visual_region"
    ]
    assert [case["type_filter"] for case in runner.MULTIMODAL_VECTOR_CASES] == [
        "media_artifact",
        "visual_region",
    ]
    assert all(case["expected_title"] for case in runner.MULTIMODAL_VECTOR_CASES)
