#!/bin/bash
# BrainCore pre-push sanitization gate
# Returns exit 0 only if ALL gates pass (zero matches).
# See CLAUDE.md and AGENTS.md for context.
set -u
cd "$(dirname "$0")/.." || exit 2

GATE_FAILED=0

check_gate() {
  local gate_name="$1"
  local pattern="$2"
  local extra_filter="${3:-cat}"

  local matches
  matches=$(git ls-files | xargs grep -l -E "$pattern" 2>/dev/null \
    | grep -v '.env.example' \
    | grep -v 'scripts/pre-push-gate.sh' \
    | eval "$extra_filter")

  if [ -n "$matches" ]; then
    echo "FAIL: $gate_name"
    echo "$matches" | sed 's/^/  /'
    GATE_FAILED=1
  else
    echo "PASS: $gate_name"
  fi
}

echo "=== BrainCore Pre-push Gate ==="
echo ""
echo "--- Remote verification ---"
git remote -v
echo ""
echo "--- Branch ---"
git branch --show-current
echo ""
echo "--- Working tree status ---"
git status --porcelain
echo ""
echo "--- .env tracking check ---"
if git ls-files | grep -qE '^\.env$'; then
  echo "FAIL: .env is tracked in git"
  GATE_FAILED=1
else
  echo "PASS: .env is not tracked"
fi
echo ""
echo "--- Sanitization gates (8) ---"
check_gate "Gate 1 credentials"       "4c31f52e|PGPASSWORD"
check_gate "Gate 2 private IPs"       "192\.168\.|10\.0\."
check_gate "Gate 3 chat IDs"          "8711262954|1341790623"
check_gate "Gate 4 personal projects" "shockfeed|onlyfans|brandibaby|polymarket|nanoclaw|DAD_Case|buddyx"
check_gate "Gate 5 home paths"        "/home/minion"
check_gate "Gate 6 hostnames"         "\blila\b|\bminion\b|\brava\b|\bblade\b" "grep -v README.md"
check_gate "Gate 7 homelab literal"   "homelab"
check_gate "Gate 8 inline DSN"        "postgresql://[^$]"

echo ""
if [ "$GATE_FAILED" -eq 1 ]; then
  echo "=== PRE-PUSH GATE FAILED — DO NOT PUSH ==="
  exit 1
fi
echo "=== ALL GATES PASSED — safe to push ==="
exit 0
