"""Pytest bootstrap for BrainCore.

Ensure the repo root is first on sys.path so local imports resolve to this
checkout instead of any site-packages install of similarly named modules.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
root_str = str(ROOT)
if sys.path[:1] != [root_str]:
    sys.path.insert(0, root_str)


def pytest_sessionstart(session):  # type: ignore[unused-argument]
    """Ensure migration-dependent tests see a real schema."""
    test_dsn = os.environ.get("BRAINCORE_TEST_DSN")
    if not test_dsn:
        return
    env = os.environ.copy()
    env.setdefault("BRAINCORE_POSTGRES_DSN", test_dsn)
    subprocess.run(
        ["bun", "src/cli.ts", "migrate"],
        cwd=ROOT,
        check=True,
        env=env,
    )
