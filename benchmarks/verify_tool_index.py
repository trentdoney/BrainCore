#!/usr/bin/env python3
"""CI merge gate: verify ``.agents/TOOL_INDEX.yaml`` matches the live FastMCP app.

This script parses a TOOL_INDEX.yaml manifest and diffs the declared
tool list against the tools actually registered on the example FastMCP
server (``examples/mcp_server/server.app``). It is designed to run in
CI on every PR to prevent silent drift between the agent-discovery
manifest and the runtime-registered tools.

Usage::

    # Real run against a checked-out repo
    python benchmarks/verify_tool_index.py --tool-index .agents/TOOL_INDEX.yaml

    # Self-test against a baked-in fixture (no repo needed)
    python benchmarks/verify_tool_index.py --self-test

Exits 0 on match, 1 on mismatch (with a diff printed to stderr),
2 on hard error (bad YAML, missing file, import failure).

Phase 0 status
--------------
``.agents/TOOL_INDEX.yaml`` does NOT yet exist in the live repo. This
script is wired up now so that when Phase 3 drafts the TOOL_INDEX and
Phase 4 adds the CI job, the gate turns on with zero code changes.
The ``--self-test`` branch exercises the diff logic against a
hard-coded fixture that proves matching and mismatching behaviour.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import types
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# Namespace collision escape hatch (see examples/mcp_server/server.py)
# ---------------------------------------------------------------------------


def _scrub_sys_path_for_mcp_collision() -> None:
    cwd = os.getcwd()
    if os.path.isdir(os.path.join(cwd, "mcp")):
        sys.path[:] = [p for p in sys.path if p not in ("", cwd)]


# ---------------------------------------------------------------------------
# TOOL_INDEX parsing
# ---------------------------------------------------------------------------


def parse_tool_index(path: Path) -> set[str]:
    """Return the set of declared tool names from a TOOL_INDEX.yaml file.

    Expected YAML shape::

        tools:
          - name: memory-search
            description: ...
          - name: memory-state-at
            description: ...
    """
    if not path.is_file():
        raise FileNotFoundError(f"tool index not found: {path}")
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    tools_raw = data.get("tools") or []
    names: set[str] = set()
    for entry in tools_raw:
        if isinstance(entry, dict) and "name" in entry:
            names.add(str(entry["name"]))
        elif isinstance(entry, str):
            names.add(entry)
    return names


# ---------------------------------------------------------------------------
# Live app introspection
# ---------------------------------------------------------------------------


def load_server_app() -> Any:
    """Import ``examples.mcp_server.server`` and return its ``app`` object.

    Handles the two Stream B escape hatches: sys.path scrub for the
    repo-root ``mcp/`` collision, and loading via
    ``importlib.util.spec_from_file_location`` so the example server
    module can be found even without a proper package on sys.path.
    """
    _scrub_sys_path_for_mcp_collision()

    server_path = REPO_ROOT / "examples" / "mcp_server" / "server.py"
    if not server_path.is_file():
        raise FileNotFoundError(f"example server not found: {server_path}")

    # Ensure synthetic package namespace so dotted imports work.
    pkg_parent = REPO_ROOT / "examples"
    if "examples" not in sys.modules:
        pkg = types.ModuleType("examples")
        pkg.__path__ = [str(pkg_parent)]  # type: ignore[attr-defined]
        sys.modules["examples"] = pkg
    if "examples.mcp_server" not in sys.modules:
        mcp_server_pkg = types.ModuleType("examples.mcp_server")
        mcp_server_pkg.__path__ = [str(server_path.parent)]  # type: ignore[attr-defined]
        sys.modules["examples.mcp_server"] = mcp_server_pkg

    spec = importlib.util.spec_from_file_location(
        "examples.mcp_server.server", server_path
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"could not build spec for {server_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["examples.mcp_server.server"] = module
    spec.loader.exec_module(module)
    return module.app


def live_tool_names(app: Any) -> set[str]:
    """Extract the set of tool names registered on a FastMCP ``app``.

    FastMCP exposes an async ``list_tools()`` that returns
    ``list[mcp.types.Tool]``. For CI gate purposes this helper runs it
    synchronously and returns a flat set of names.
    """
    import asyncio

    tools = asyncio.get_event_loop().run_until_complete(app.list_tools())
    return {t.name for t in tools}


# ---------------------------------------------------------------------------
# Diff logic
# ---------------------------------------------------------------------------


def diff_tool_sets(declared: set[str], live: set[str]) -> tuple[set[str], set[str]]:
    """Return ``(only_in_declared, only_in_live)`` symmetric difference."""
    return declared - live, live - declared


def format_diff(only_declared: set[str], only_live: set[str]) -> str:
    lines: list[str] = []
    if only_declared:
        lines.append("Declared in TOOL_INDEX.yaml but NOT registered on app:")
        for name in sorted(only_declared):
            lines.append(f"  - {name}")
    if only_live:
        lines.append("Registered on app but NOT in TOOL_INDEX.yaml:")
        for name in sorted(only_live):
            lines.append(f"  - {name}")
    return "\n".join(lines) if lines else "(no diff)"


# ---------------------------------------------------------------------------
# Self-test fixture
# ---------------------------------------------------------------------------


_FIXTURE_TOOL_INDEX_YAML = """\
tools:
  - name: memory-search
    description: 4-stream hybrid retrieval
  - name: memory-state-at
    description: temporal point-in-time query
"""


def _run_self_test() -> int:
    """Exercise the diff logic against a hard-coded fixture."""
    import tempfile

    errors = 0

    with tempfile.TemporaryDirectory() as tmp:
        fixture_path = Path(tmp) / "TOOL_INDEX.yaml"
        fixture_path.write_text(_FIXTURE_TOOL_INDEX_YAML, encoding="utf-8")

        declared = parse_tool_index(fixture_path)
        expected_declared = {"memory-search", "memory-state-at"}
        if declared != expected_declared:
            print(
                f"FAIL: parse_tool_index returned {declared}, expected {expected_declared}",
                file=sys.stderr,
            )
            errors += 1

        # Case 1: matching sets -> empty diff
        live_match = {"memory-search", "memory-state-at"}
        only_d, only_l = diff_tool_sets(declared, live_match)
        if only_d or only_l:
            print(
                f"FAIL: matching sets produced diff declared={only_d} live={only_l}",
                file=sys.stderr,
            )
            errors += 1

        # Case 2: tool missing from app (drift after app delete)
        live_missing = {"memory-search"}
        only_d, only_l = diff_tool_sets(declared, live_missing)
        if only_d != {"memory-state-at"} or only_l:
            print(
                f"FAIL: missing-from-app diff wrong declared={only_d} live={only_l}",
                file=sys.stderr,
            )
            errors += 1

        # Case 3: extra tool on app (new tool not yet in index)
        live_extra = {"memory-search", "memory-state-at", "memory-explain"}
        only_d, only_l = diff_tool_sets(declared, live_extra)
        if only_d or only_l != {"memory-explain"}:
            print(
                f"FAIL: extra-on-app diff wrong declared={only_d} live={only_l}",
                file=sys.stderr,
            )
            errors += 1

        # Case 4: format_diff produces a non-empty human string when mismatched
        rendered = format_diff({"only-declared"}, {"only-live"})
        if "only-declared" not in rendered or "only-live" not in rendered:
            print("FAIL: format_diff did not include both sides", file=sys.stderr)
            errors += 1

    if errors == 0:
        print("verify_tool_index self-test: PASS (4/4 cases)")
        return 0
    print(f"verify_tool_index self-test: FAIL ({errors} case(s))", file=sys.stderr)
    return 1


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tool-index",
        type=Path,
        default=REPO_ROOT / ".agents" / "TOOL_INDEX.yaml",
        help="Path to TOOL_INDEX.yaml (default: .agents/TOOL_INDEX.yaml)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run the baked-in fixture test and exit",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return _run_self_test()

    try:
        declared = parse_tool_index(args.tool_index)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except yaml.YAMLError as exc:
        print(f"ERROR: malformed YAML: {exc}", file=sys.stderr)
        return 2

    try:
        app = load_server_app()
        live = live_tool_names(app)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: could not load live app: {exc}", file=sys.stderr)
        return 2

    only_declared, only_live = diff_tool_sets(declared, live)
    if only_declared or only_live:
        print("MISMATCH between TOOL_INDEX.yaml and live FastMCP app:", file=sys.stderr)
        print(format_diff(only_declared, only_live), file=sys.stderr)
        return 1

    print(f"OK: {len(declared)} tool(s) match between TOOL_INDEX.yaml and live app")
    return 0


if __name__ == "__main__":
    sys.exit(main())
