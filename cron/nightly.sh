#!/bin/bash
# BrainCore Nightly Pipeline v2 — Parallel execution with failure isolation
set -uo pipefail  # NO -e — we want partial success

BRAINCORE="$(cd "$(dirname "$0")/.." && pwd)"

# Source .env if present
if [ -f "$BRAINCORE/.env" ]; then
  set -a
  source "$BRAINCORE/.env"
  set +a
fi

LOG_DIR="${BRAINCORE_LOG_DIR:-$BRAINCORE/logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/nightly-$(date +%Y%m%d).log"
FAIL_FLAGS="$LOG_DIR/nightly-failures-$(date +%Y%m%d)"
: > "$FAIL_FLAGS"

# Cron overlap protection via flock
exec 200>"$BRAINCORE/.nightly.lock"
if ! flock -n 200; then
  echo "[$(date -Iseconds)] Another nightly run is in progress — exiting" | tee -a "$LOG"
  exit 0
fi

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }

alert() {
  local msg="$1"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log "DRY: would alert: $msg"
    return 0
  fi
  log "ALERT: $msg"
  if [ -n "${BRAINCORE_TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${BRAINCORE_TELEGRAM_CHAT_ID:-}" ]; then
    curl -sf "https://api.telegram.org/bot${BRAINCORE_TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="$BRAINCORE_TELEGRAM_CHAT_ID" \
      -d text="BrainCore: $msg" > /dev/null 2>&1 || true
  fi
}

run_step() {
  local name="$1"; shift
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log "DRY: would run [$name]: $*"
    return 0
  fi
  log "START: $name"
  if "$@" >> "$LOG" 2>&1; then
    log "OK: $name"
    return 0
  else
    log "FAIL: $name"
    echo "$name" >> "$FAIL_FLAGS"
    return 1
  fi
}

# Python interpreter (override via BRAINCORE_PYTHON env var)
PYTHON="${BRAINCORE_PYTHON:-python3}"

resolve_bun() {
  if [ -n "${BRAINCORE_BUN:-}" ]; then
    if [ -x "$BRAINCORE_BUN" ]; then
      printf '%s\n' "$BRAINCORE_BUN"
      return 0
    fi
    printf 'BRAINCORE_BUN is set but not executable: %s\n' "$BRAINCORE_BUN" >&2
    return 1
  fi

  local home_bun="${HOME:-}/.bun/bin/bun"
  if [ -n "${HOME:-}" ] && [ -x "$home_bun" ]; then
    printf '%s\n' "$home_bun"
    return 0
  fi

  command -v bun
}

cd "$BRAINCORE"
log "=== BrainCore nightly pipeline v2 starting ==="
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "Mode: DRY_RUN"
else
  log "Mode: LIVE"
fi

if ! BUN_BIN="$(resolve_bun 2>>"$LOG")"; then
  log "FAIL: Bun not available; set BRAINCORE_BUN or install Bun under $HOME/.bun/bin/bun"
  echo "bun-resolver" >> "$FAIL_FLAGS"
  alert "Nightly aborted: Bun not available"
  exit 1
fi
log "Bun: $BUN_BIN"

# Preflight: fail before extraction if runtime code and DB schema drift apart.
if ! run_step "schema-check" "$BUN_BIN" src/cli.ts schema-check; then
  alert "Nightly aborted: BrainCore schema drift detected"
  exit 1
fi

# Visibility: vLLM can be down without blocking deterministic extraction, but
# it must leave an explicit trace in the nightly log for follow-up.
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY: would run [vllm-health]: $BUN_BIN src/cli.ts health-check"
else
  log "START: vllm-health"
  VLLM_HEALTH="$($BUN_BIN src/cli.ts health-check 2>&1 || true)"
  printf '%s\n' "$VLLM_HEALTH" >> "$LOG"
  if printf '%s\n' "$VLLM_HEALTH" | grep -q '\[OK\]'; then
    log "OK: vllm-health"
  else
    log "WARN: vLLM unreachable -- semantic extraction may fall back or skip"
  fi
fi

# Group A: Independent ingestion (parallel)
log "Group A: codex-sync"
if [ -n "${BRAINCORE_CODEX_SYNC_SRC:-}" ] && [ -n "${BRAINCORE_CODEX_SYNC_DEST:-}" ]; then
  run_step "codex-sync" rsync -a "$BRAINCORE_CODEX_SYNC_SRC" "$BRAINCORE_CODEX_SYNC_DEST"
else
  log "SKIP: codex-sync (BRAINCORE_CODEX_SYNC_SRC/DEST not set)"
fi
log "Group A complete"

# Group B: Archive pending artifacts
log "Group B: archive pending"
run_step "archive" "$BUN_BIN" src/cli.ts archive --pending

# Group C: Parallel extraction from all sources
log "Group C: extraction (parallel)"
run_step "extract-pending" "$BUN_BIN" src/cli.ts extract --pending &
run_step "extract-codex-shared" "$BUN_BIN" src/cli.ts extract --codex-shared &
run_step "extract-codex-history" "$BUN_BIN" src/cli.ts extract --codex-history &
run_step "extract-discord" "$BUN_BIN" src/cli.ts extract --discord &
run_step "extract-telegram" "$BUN_BIN" src/cli.ts extract --telegram &
run_step "extract-grafana" "$BUN_BIN" src/cli.ts extract --grafana &
wait
log "Group C complete"

# Group D: Post-processing (sequential dependencies)
log "Group D: post-processing (sequential)"
run_step "embeddings" $PYTHON scripts/backfill-embeddings.py
run_step "project-tag" "$BUN_BIN" src/cli.ts project tag --retag-all
run_step "consolidate" "$BUN_BIN" src/cli.ts consolidate --delta
run_step "publish" "$BUN_BIN" src/cli.ts publish-notes --changed

# Weekly maintenance (Sundays)
if [ "$(date +%u)" = "7" ]; then
  log "Weekly maintenance"
  run_step "vacuum" "$BUN_BIN" src/cli.ts maintenance --vacuum
  run_step "stale-detect" "$BUN_BIN" src/cli.ts consolidate --detect-stale
fi

# Monthly reindex (1st of month)
if [ "$(date +%d)" = "01" ]; then
  log "Monthly reindex"
  run_step "reindex" $PYTHON scripts/reindex-vectors.py
fi

# Final gate check
run_step "gate-check" "$BUN_BIN" src/cli.ts gate-check

# Summary
FAIL_COUNT=$(wc -l < "$FAIL_FLAGS" 2>/dev/null || echo 0)
FACT_COUNT=$($PYTHON -c "
import psycopg, os
c = psycopg.connect(os.environ['BRAINCORE_POSTGRES_DSN'])
cur = c.cursor()
cur.execute('SELECT count(*) FROM preserve.fact')
print(cur.fetchone()[0])
c.close()
" 2>/dev/null || echo '?')

if [ "$FAIL_COUNT" -gt 0 ]; then
  FAILED_STEPS=$(tr '\n' ',' < "$FAIL_FLAGS" | sed 's/,$//')
  alert "Nightly complete with $FAIL_COUNT failures: $FAILED_STEPS. Facts: $FACT_COUNT"
else
  alert "Nightly complete cleanly. Facts: $FACT_COUNT"
fi

log "=== BrainCore nightly pipeline complete ==="
