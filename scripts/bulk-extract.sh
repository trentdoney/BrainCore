#!/usr/bin/env bash
###############################################################################
# bulk-extract.sh — Run deterministic extraction on all OpsVault incidents
# Uses BrainCore CLI extract --skip-semantic.
#
# Scans BOTH:
#   - ./data/vault/20_devices/*/incidents/*
#   - ./data/vault/10_projects/*/incidents/*
###############################################################################
set -uo pipefail

OPSVAULT_ROOT="./data/vault"
STRATA_DIR="."
LOG="/tmp/braincore-extract-$(date +%Y%m%d-%H%M%S).log"

extracted=0
failed=0
skipped=0
total=0

log() {
  echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"
}

log "=== BrainCore Bulk Extract (deterministic) ==="

# Find all incident directories from BOTH 20_devices and 10_projects
find_incidents() {
  # Standard INC-* directories under 20_devices
  find "$OPSVAULT_ROOT/20_devices" -maxdepth 3 -type d -name INC-* 2>/dev/null
  # Standard INC-* directories under 10_projects
  find "$OPSVAULT_ROOT/10_projects" -maxdepth 3 -type d -name INC-* 2>/dev/null
  # Non-standard naming: any directory under */incidents/ that has notes.md or incident.md
  find "$OPSVAULT_ROOT/10_projects" -maxdepth 3 -mindepth 3 -type d -path */incidents/* ! -name INC-* 2>/dev/null
  find "$OPSVAULT_ROOT/20_devices" -maxdepth 3 -mindepth 3 -type d -path */incidents/* ! -name INC-* 2>/dev/null
}

find_incidents | sort -u | while IFS= read -r inc_dir; do
  total=$((total + 1))
  slug=$(basename "$inc_dir")

  # Must have notes.md or incident.md
  if [[ ! -f "$inc_dir/notes.md" ]] && [[ ! -f "$inc_dir/incident.md" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  # Run extraction
  output=$(cd "$STRATA_DIR" && bun src/cli.ts extract --incident "$inc_dir" --skip-semantic 2>&1)
  rc=$?

  if echo "$output" | grep -q "\[4/4\] Done."; then
    extracted=$((extracted + 1))
  elif echo "$output" | grep -q "Using existing artifact"; then
    extracted=$((extracted + 1))
  else
    failed=$((failed + 1))
    log "FAIL: $slug (rc=$rc)"
    echo "$output" >> "$LOG"
  fi

  # Progress every 50
  if (( (extracted + failed) % 50 == 0 )) && (( extracted + failed > 0 )); then
    log "Progress: $extracted extracted, $failed failed, $skipped skipped"
  fi
done

log ""
log "=== Extract Complete ==="
log "Extracted: $extracted"
log "Failed:    $failed"
log "Skipped:   $skipped"
log "Log:       $LOG"
