#!/bin/bash
# BrainCore smoke test — verify basic functionality
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRAINCORE="${SCRIPT_DIR}/.."

cd "$BRAINCORE"

echo "=== BrainCore Smoke Test ==="
echo ""

# 1. Check bun is available
echo -n "[1/6] Bun runtime... "
if command -v bun &>/dev/null; then
  echo "OK ($(bun --version))"
else
  echo "FAIL (bun not found)"
  exit 1
fi

# 2. Check dependencies installed
echo -n "[2/6] Dependencies... "
if [ -d "node_modules" ]; then
  echo "OK"
else
  echo "INSTALLING..."
  bun install --silent
  echo "       OK"
fi

# 3. TypeScript compilation check
echo -n "[3/6] TypeScript check... "
if bunx tsc --noEmit >/dev/null 2>&1; then
  echo "OK"
else
  echo "FAIL (compilation errors)"
  exit 1
fi

# 4. Check .env exists
echo -n "[4/6] Configuration... "
if [ -f ".env" ]; then
  echo "OK (.env found)"
else
  echo "WARN (.env not found — copy .env.example to .env)"
fi

# 5. Database connection + migration path
echo -n "[5/6] Database + migrations... "
DB_OUTPUT=$(bun src/cli.ts migrate 2>&1 || true)
if echo "$DB_OUTPUT" | grep -q "Migrations complete."; then
  echo "OK"
elif echo "$DB_OUTPUT" | grep -q "Missing required environment variable: BRAINCORE_POSTGRES_DSN"; then
  echo "SKIP (no BRAINCORE_POSTGRES_DSN configured)"
elif echo "$DB_OUTPUT" | grep -q "connection failed"; then
  echo "FAIL (check BRAINCORE_POSTGRES_DSN)"
else
  echo "FAIL"
  echo "$DB_OUTPUT"
  exit 1
fi

# 6. Health check
echo -n "[6/6] LLM endpoints... "
HEALTH_OUTPUT=$(bun src/cli.ts health-check 2>&1 || true)
HEALTHY=$(echo "$HEALTH_OUTPUT" | grep -c "\[OK\]" || true)
TOTAL=$(echo "$HEALTH_OUTPUT" | grep -c "\[" || true)
echo "${HEALTHY}/${TOTAL} healthy"

echo ""
echo "=== Smoke Test Complete ==="
