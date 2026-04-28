#!/bin/bash
# BrainCore pre-push sanitization gate
# Returns exit 0 only if ALL gates pass (zero matches).
# See AGENTS.md for context.
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
if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: working tree has uncommitted changes"
  GATE_FAILED=1
else
  echo "PASS: working tree is clean"
fi
echo ""
echo "--- .env tracking check ---"
if git ls-files | grep -qE '^\.env$'; then
  echo "FAIL: .env is tracked in git"
  GATE_FAILED=1
else
  echo "PASS: .env is not tracked"
fi
echo ""
echo "--- Sanitization gates (9) ---"
check_gate "Gate 1 credentials"       "BRAINCORE_SYNTHETIC_SECRET_SENTINEL|PGPASSWORD"
check_gate "Gate 2 private IPs"       "192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3}"
check_gate "Gate 3 chat IDs"          "chat[_-]?id[[:space:]]*[:=][[:space:]]*['\"]?[0-9]{6,}"
if [ -n "${BRAINCORE_PRIVATE_NAME_PATTERN:-}" ]; then
  check_gate "Gate 4 private names" "$BRAINCORE_PRIVATE_NAME_PATTERN"
else
  echo "PASS: Gate 4 private names (no deployment-specific pattern configured)"
fi
check_gate "Gate 5 home paths"        "/home/[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._-]+"
if [ -n "${BRAINCORE_PRIVATE_HOST_PATTERN:-}" ]; then
  check_gate "Gate 6 hostnames" "$BRAINCORE_PRIVATE_HOST_PATTERN" "grep -v README.md"
else
  echo "PASS: Gate 6 hostnames (no deployment-specific pattern configured)"
fi
if [ -n "${BRAINCORE_PRIVATE_CONTEXT_PATTERN:-}" ]; then
  check_gate "Gate 7 private context" "$BRAINCORE_PRIVATE_CONTEXT_PATTERN"
else
  echo "PASS: Gate 7 private context (no deployment-specific pattern configured)"
fi
check_gate "Gate 8 inline DSN"        "postgresql://[^$]"
INTERNAL_PROJECT_PATTERN="$(printf '%s|%s|%s|%s|%s|%s' \
  'Ops''Vault' \
  'ops''vault' \
  '/s''rv/' \
  'calm''-skipping-''sedgewick' \
  'launch blocker B''L-[0-9]+' \
  'Stream [A-Z]')"
check_gate "Gate 9 internal project terms" "$INTERNAL_PROJECT_PATTERN"

echo ""
if [ "$GATE_FAILED" -eq 1 ]; then
  echo "=== PRE-PUSH GATE FAILED — DO NOT PUSH ==="
  exit 1
fi
echo "=== ALL GATES PASSED ==="
exit 0
