#!/usr/bin/env bash
###############################################################################
# bulk-semantic.sh — Run full extraction (deterministic + semantic) on all
# vault incidents that lack semantic LLM facts.
# Designed to run on your GPU host with vLLM.
###############################################################################
set -uo pipefail

VAULT_ROOT="./data/vault"
BRAINCORE_DIR="."
LOG="/tmp/braincore-semantic-$(date +%Y%m%d-%H%M%S).log"
PROGRESS_FILE="/tmp/braincore-semantic-progress.txt"

extracted=0
failed=0
skipped=0
total=0
start_time=$(date +%s)

log() {
  echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"
}

update_progress() {
  local now=$(date +%s)
  local elapsed=$(( now - start_time ))
  local rate=0
  local processed=$((extracted + failed))
  if (( processed > 0 )); then
    rate=$(( elapsed / processed ))
  fi
  echo "extracted=$extracted failed=$failed skipped=$skipped total=$total elapsed=${elapsed}s rate=${rate}s/inc" > "$PROGRESS_FILE"
}

log "=== BrainCore Bulk Semantic Extraction ==="
log "Log: $LOG"

find_incidents() {
  find "$VAULT_ROOT/20_devices" -maxdepth 3 -type d -name INC-* 2>/dev/null
  find "$VAULT_ROOT/10_projects" -maxdepth 3 -type d -name INC-* 2>/dev/null
  find "$VAULT_ROOT/10_projects" -maxdepth 3 -mindepth 3 -type d -path */incidents/* ! -name INC-* 2>/dev/null
  find "$VAULT_ROOT/20_devices" -maxdepth 3 -mindepth 3 -type d -path */incidents/* ! -name INC-* 2>/dev/null
}

while IFS= read -r inc_dir; do
  total=$((total + 1))
  slug=$(basename "$inc_dir")

  # Must have notes.md or incident.md
  if [[ ! -f "$inc_dir/notes.md" ]] && [[ ! -f "$inc_dir/incident.md" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  # Run full extraction (deterministic + semantic)
  output=$(cd "$BRAINCORE_DIR" && timeout 180 bun src/cli.ts extract --incident "$inc_dir" 2>&1)
  rc=$?

  if [[ $rc -eq 0 ]] && echo "$output" | grep -q "\[4/4\] Done."; then
    extracted=$((extracted + 1))
    # Log semantic counts
    sem_count=$(echo "$output" | awk -F': ' '/Semantic facts:/ {print $2; exit}')
    lessons=$(echo "$output" | awk -F': ' '/Lessons learned:/ {print $2; exit}')
    log "OK: $slug (semantic=$sem_count lessons=$lessons)"
  elif echo "$output" | grep -q "Using existing artifact"; then
    extracted=$((extracted + 1))
    sem_count=$(echo "$output" | awk -F': ' '/Semantic facts:/ {print $2; exit}')
    log "OK: $slug (semantic=$sem_count)"
  else
    failed=$((failed + 1))
    log "FAIL: $slug (rc=$rc)"
    echo "$output" >> "$LOG"
  fi

  update_progress

  # Progress summary every 25
  if (( (extracted + failed) % 25 == 0 )) && (( extracted + failed > 0 )); then
    local_now=$(date +%s)
    local_elapsed=$(( local_now - start_time ))
    local_processed=$((extracted + failed))
    local_remaining=$((total - local_processed - skipped))
    if (( local_processed > 0 )); then
      local_rate=$(( local_elapsed / local_processed ))
      local_eta=$(( local_rate * local_remaining ))
      log "=== PROGRESS: $local_processed processed ($extracted ok, $failed fail) | ${local_elapsed}s elapsed | ETA ~${local_eta}s ==="
    fi
  fi

  # Brief pause to not hammer the GPU
  sleep 0.5
done < <(find_incidents | sort -u)

end_time=$(date +%s)
total_time=$(( end_time - start_time ))

log ""
log "=== Semantic Extraction Complete ==="
log "Extracted: $extracted"
log "Failed:    $failed"
log "Skipped:   $skipped"
log "Total time: ${total_time}s"
log "Log:       $LOG"

echo "DONE: extracted=$extracted failed=$failed skipped=$skipped time=${total_time}s"
