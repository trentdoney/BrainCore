#!/bin/bash
# BrainCore nightly preservation pipeline — fully automated
# Schedule: 40 2 * * * (02:40 daily)
set -euo pipefail

# Source environment
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRAINCORE="${SCRIPT_DIR}/.."
LOG="${BRAINCORE}/logs/braincore-nightly.log"

# Load .env if present
if [ -f "${BRAINCORE}/.env" ]; then
  set -a; source "${BRAINCORE}/.env"; set +a
fi

TELEGRAM_BOT_TOKEN="${BRAINCORE_TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${BRAINCORE_TELEGRAM_CHAT_ID:-}"

log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }
alert() {
  local msg="$1"
  log "ALERT: $msg"
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="$TELEGRAM_CHAT_ID" \
      -d text="BrainCore: $msg" > /dev/null 2>&1 || true
  fi
}

# Ensure log directory exists
mkdir -p "$(dirname "$LOG")"

log "=== BrainCore nightly pipeline starting ==="
PIPELINE_START=$(date +%s)
FAILURES=0

# -- 1. Scan for new artifacts --
log "Phase 1: scan"
cd "$BRAINCORE" && bun src/cli.ts scan --lead-window 14 >> "$LOG" 2>&1 \
  || { alert "Scan failed"; ((FAILURES++)) || true; }

# -- 2. Archive pending artifacts --
log "Phase 2: archive"
cd "$BRAINCORE" && bun src/cli.ts archive --pending >> "$LOG" 2>&1 \
  || { alert "Archive failed"; ((FAILURES++)) || true; }

# -- 3. Extract (deterministic + semantic via vLLM or Claude CLI fallback) --
log "Phase 3: extract"
cd "$BRAINCORE" && bun src/cli.ts extract --pending >> "$LOG" 2>&1 \
  || { alert "Extraction failed"; ((FAILURES++)) || true; }

# -- 4. Extract Codex data --
log "Phase 4: codex-extract"
cd "$BRAINCORE" && bun src/cli.ts extract --codex-shared >> "$LOG" 2>&1 \
  || { alert "Codex shared extraction failed"; ((FAILURES++)) || true; }
cd "$BRAINCORE" && bun src/cli.ts extract --codex-history >> "$LOG" 2>&1 \
  || { alert "Codex history extraction failed"; ((FAILURES++)) || true; }

# -- 5. Discord digest extraction --
log "Phase 5: discord-extract"
cd "$BRAINCORE" && bun src/cli.ts extract --discord >> "$LOG" 2>&1 \
  || { alert "Discord extraction failed"; ((FAILURES++)) || true; }

# -- 6. Telegram chat extraction --
log "Phase 6: telegram-extract"
cd "$BRAINCORE" && bun src/cli.ts extract --telegram >> "$LOG" 2>&1 \
  || { alert "Telegram extraction failed"; ((FAILURES++)) || true; }

# -- 7. Grafana alert extraction --
log "Phase 7: grafana-extract"
cd "$BRAINCORE" && bun src/cli.ts extract --grafana >> "$LOG" 2>&1 \
  || { alert "Grafana extraction failed"; ((FAILURES++)) || true; }

# -- 8. Backfill embeddings --
log "Phase 8: embeddings"
python3 "${BRAINCORE}/scripts/backfill-embeddings.py" >> "$LOG" 2>&1 \
  || { alert "Embedding backfill failed"; ((FAILURES++)) || true; }

# -- 9. Project re-tag --
log "Phase 9: project-tag"
cd "$BRAINCORE" && bun src/cli.ts project tag --retag-all >> "$LOG" 2>&1 \
  || log "Project re-tag skipped or failed (non-critical)"

# -- 10. Consolidate patterns/playbooks --
log "Phase 10: consolidate"
cd "$BRAINCORE" && bun src/cli.ts consolidate --delta >> "$LOG" 2>&1 \
  || { alert "Consolidation failed"; ((FAILURES++)) || true; }

# -- 11. Publish notes --
log "Phase 11: publish"
cd "$BRAINCORE" && bun src/cli.ts publish-notes --changed >> "$LOG" 2>&1 \
  || { alert "Publish notes failed"; ((FAILURES++)) || true; }

# -- 12. Gate check (alert blocked artifacts) --
log "Phase 12: gate-check"
cd "$BRAINCORE" && bun src/cli.ts gate-check >> "$LOG" 2>&1 \
  || { alert "Gate check failed"; ((FAILURES++)) || true; }

# -- 13. Weekly maintenance (Sundays) --
if [ "$(date +%u)" = "7" ]; then
  log "Phase 13: weekly-vacuum"
  cd "$BRAINCORE" && bun src/cli.ts maintenance --vacuum >> "$LOG" 2>&1 \
    || { alert "Weekly VACUUM failed"; ((FAILURES++)) || true; }

  log "Phase 13b: staleness-detection"
  cd "$BRAINCORE" && bun src/cli.ts maintenance --detect-stale >> "$LOG" 2>&1 \
    || { alert "Stale detection failed"; ((FAILURES++)) || true; }
fi

# -- Final notification --
PIPELINE_END=$(date +%s)
DURATION=$(( PIPELINE_END - PIPELINE_START ))

if [ "$FAILURES" -gt 0 ]; then
  alert "Nightly pipeline complete with ${FAILURES} failure(s). Duration: ${DURATION}s"
else
  alert "Nightly pipeline complete. Duration: ${DURATION}s"
fi

log "=== BrainCore nightly pipeline complete (${FAILURES} failures, ${DURATION}s) ==="
