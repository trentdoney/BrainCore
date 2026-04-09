#!/bin/bash
# SessionEnd hook — archive the current session asynchronously
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.." && bun src/cli.ts archive-session 2>/dev/null &
