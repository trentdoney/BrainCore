#!/usr/bin/env bash
###############################################################################
# bulk-archive.sh — Archive all OpsVault incidents to ./data/archive/
#
# Runs on your archive host. For each incident directory:
#   1. Skip if already in preserve.archive_object (by source_key)
#   2. Compress to .tar.zst
#   3. Generate sidecar manifest JSON
#   4. Insert into preserve.archive_object
#   5. Verify checksum
#
# Scans BOTH:
#   - ./data/vault/20_devices/*/incidents/*
#   - ./data/vault/10_projects/*/incidents/*
#
# Usage: bash bulk-archive.sh [--dry-run]
###############################################################################
set -euo pipefail

ARCHIVE_ROOT="./data/archive/opsvault_incident"
OPSVAULT_ROOT="./data/vault"
PG_DSN="${BRAINCORE_POSTGRES_DSN:-postgresql://braincore:braincore@localhost:5432/braincore}"
DRY_RUN=false
LOG_FILE="./data/archive/bulk-archive-$(date +%Y%m%d-%H%M%S).log"

[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

mkdir -p "$ARCHIVE_ROOT"

# Counters
archived=0
skipped=0
failed=0
total=0

log() {
  local msg="[$(date +%H:%M:%S)] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

log "=== BrainCore Bulk Archive ==="
log "Archive root: $ARCHIVE_ROOT"
log "Dry run: $DRY_RUN"
log ""

# Get existing source_keys from DB
existing_keys=$(psql "$PG_DSN" -t -A -c "SELECT source_key FROM preserve.archive_object;" 2>/dev/null || echo "")

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

while IFS= read -r inc_dir; do
  total=$((total + 1))
  slug=$(basename "$inc_dir")

  # Skip if already archived
  if echo "$existing_keys" | grep -qF "$slug"; then
    skipped=$((skipped + 1))
    continue
  fi

  # Check for notes.md or incident.md
  if [[ ! -f "$inc_dir/notes.md" ]] && [[ ! -f "$inc_dir/incident.md" ]]; then
    log "SKIP (no notes): $slug"
    skipped=$((skipped + 1))
    continue
  fi

  archive_path="$ARCHIVE_ROOT/${slug}.tar.zst"
  manifest_path="$ARCHIVE_ROOT/${slug}.manifest.json"

  if $DRY_RUN; then
    log "DRY-RUN: would archive $slug"
    archived=$((archived + 1))
    continue
  fi

  # Compress
  if ! tar --zstd -cf "$archive_path" -C "$(dirname "$inc_dir")" "$slug" 2>>/tmp/braincore-tar-errors.log; then
    log "FAIL (tar): $slug"
    failed=$((failed + 1))
    rm -f "$archive_path"
    continue
  fi

  # Sizes
  original_bytes=$(du -sb "$inc_dir" | cut -f1)
  compressed_bytes=$(stat -c%s "$archive_path")

  # SHA256
  checksum=$(sha256sum "$archive_path" | cut -d  -f1)

  # Generate manifest
  file_listing=$(find "$inc_dir" -type f | sort | while read -r f; do
    rel_path="${f#$inc_dir/}"
    fsize=$(stat -c%s "$f")
    fhash=$(sha256sum "$f" | cut -d  -f1)
    printf  {path: %s, size: %d, sha256: %s} "$rel_path" "$fsize" "$fhash"
  done | paste -sd, -)

  cat > "$manifest_path" << MANIFEST
{
  "source_key": "$slug",
  "source_type": "opsvault_incident",
  "original_path": "$inc_dir",
  "archive_path": "$archive_path",
  "format": "tar.zst",
  "original_bytes": $original_bytes,
  "compressed_bytes": $compressed_bytes,
  "checksum_sha256": "$checksum",
  "host": "localhost",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "files": [
$file_listing
  ]
}
MANIFEST

  # Insert into DB
  if ! psql "$PG_DSN" -q -c "
    INSERT INTO preserve.archive_object
      (source_key, source_type, original_path, archive_path, manifest_path,
       format, original_bytes, compressed_bytes, checksum_sha256, host)
    VALUES
      (, opsvault_incident, , , ,
       tar.zst, $original_bytes, $compressed_bytes, , localhost)
    ON CONFLICT (source_key) DO NOTHING;
  " 2>>/tmp/braincore-psql-errors.log; then
    log "FAIL (db): $slug"
    failed=$((failed + 1))
    continue
  fi

  # Verify checksum
  verify_checksum=$(sha256sum "$archive_path" | cut -d  -f1)
  if [[ "$verify_checksum" == "$checksum" ]]; then
    psql "$PG_DSN" -q -c "
      UPDATE preserve.archive_object
      SET verified_at = now()
      WHERE source_key = ;
    " 2>/dev/null
  else
    log "WARN (checksum mismatch): $slug"
  fi

  archived=$((archived + 1))

  # Progress every 50
  if (( archived % 50 == 0 )); then
    log "Progress: $archived archived, $skipped skipped, $failed failed / $total total"
  fi

done < <(find_incidents | sort -u)

log ""
log "=== Archive Complete ==="
log "Total:    $total"
log "Archived: $archived"
log "Skipped:  $skipped"
log "Failed:   $failed"
log "Log:      $LOG_FILE"
