#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="${BRAINCORE_ASSISTANT_MEMORY_LOCK:-/tmp/braincore-assistant-memory-refresh.lock}"
PAI_AUTO_MEMORY_DIR="${BRAINCORE_PAI_AUTO_MEMORY_DIR:-}"
VESTIGE_EXPORT_PATH="${BRAINCORE_VESTIGE_EXPORT_PATH:-}"
DRY_RUN="${BRAINCORE_ASSISTANT_MEMORY_DRY_RUN:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/assistant-memory-refresh.sh [--dry-run]

Refresh BrainCore assistant-memory evidence from configured sources.

Environment:
  BRAINCORE_POSTGRES_DSN              Required by BrainCore CLI.
  BRAINCORE_TENANT                    Optional tenant override.
  BRAINCORE_PAI_AUTO_MEMORY_DIR       Optional PAI auto-memory markdown directory.
  BRAINCORE_VESTIGE_EXPORT_PATH       Optional Vestige JSON/JSONL export path.
  BRAINCORE_ASSISTANT_MEMORY_LOCK     Optional flock path.
  BRAINCORE_ASSISTANT_MEMORY_DRY_RUN  Set 1 for dry run.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "${BRAINCORE_POSTGRES_DSN:-}" ]]; then
  echo "BRAINCORE_POSTGRES_DSN is required." >&2
  exit 2
fi

run_extract() {
  local label="$1"
  shift
  echo "[$(date -Is)] Refreshing ${label}"
  if [[ "$DRY_RUN" == "1" ]]; then
    bun src/cli.ts extract "$@" --dry-run
  else
    bun src/cli.ts extract "$@"
  fi
}

cd "$ROOT_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another BrainCore assistant-memory refresh is already running: $LOCK_FILE" >&2
  exit 75
fi

if [[ -n "$PAI_AUTO_MEMORY_DIR" && -d "$PAI_AUTO_MEMORY_DIR" ]]; then
  if find "$PAI_AUTO_MEMORY_DIR" -maxdepth 1 -type f -name '*.md' ! -name 'MEMORY.md' -print -quit | grep -q .; then
    run_extract "PAI auto-memory" --pai-auto-memory "$PAI_AUTO_MEMORY_DIR"
  else
    echo "Skipping PAI auto-memory; no markdown files found: $PAI_AUTO_MEMORY_DIR" >&2
  fi
else
  echo "Skipping PAI auto-memory; BRAINCORE_PAI_AUTO_MEMORY_DIR is unset or not a directory." >&2
fi

if [[ -n "$VESTIGE_EXPORT_PATH" ]]; then
  if [[ -f "$VESTIGE_EXPORT_PATH" ]]; then
    run_extract "Vestige export" --vestige-export "$VESTIGE_EXPORT_PATH"
  else
    echo "Skipping Vestige export; file not found: $VESTIGE_EXPORT_PATH" >&2
  fi
else
  echo "Skipping Vestige export; BRAINCORE_VESTIGE_EXPORT_PATH is not set."
fi
