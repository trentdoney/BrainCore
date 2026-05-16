#!/usr/bin/env bash
# BrainCore memory governance policy gate.
# Checks BrainCore memory-governance surfaces without requiring a live database.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

check_file() {
  local path="$1"
  if [[ -f "$path" ]]; then
    echo "PASS: $path exists"
  else
    echo "FAIL: $path missing"
    fail=1
  fi
}

check_contains() {
  local path="$1"
  local pattern="$2"
  local label="$3"
  if grep -qE "$pattern" "$path" 2>/dev/null; then
    echo "PASS: $label"
  else
    echo "FAIL: $label"
    fail=1
  fi
}

echo "=== BrainCore Memory Policy Gate ==="

check_file sql/022_memory_governance.sql
check_contains src/migrate.ts '022_memory_governance\.sql' 'migration 022 is registered'
check_contains sql/022_memory_governance.sql 'memory_governance_status' 'governance status enum exists'
check_contains sql/022_memory_governance.sql 'memory_trust_class' 'trust class enum exists'
check_contains sql/022_memory_governance.sql 'memory_lifecycle_outbox' 'lifecycle outbox exists'
check_contains sql/022_memory_governance.sql 'memory_context_audit' 'prompt audit table exists'
check_contains sql/022_memory_governance.sql 'memory_feedback_event' 'feedback table exists'
check_contains sql/022_memory_governance.sql 'memory_quality_audit' 'quality audit table exists'
check_contains sql/022_memory_governance.sql 'memory_edge' 'memory edge table exists'

check_file src/memory/governance.ts
check_contains src/memory/governance.ts 'recordLifecycleEvent' 'lifecycle event write path exists'
check_contains src/memory/governance.ts 'processLifecycleEvents' 'lifecycle processor exists'
check_contains src/memory/governance.ts 'setMemoryGovernanceStatus' 'operator status write path exists'
check_contains src/memory/governance.ts 'auditPromptRead' 'prompt read audit write path exists'
check_contains src/memory/governance.ts 'recordQualityAudit' 'quality audit write path exists'
check_contains src/memory/governance.ts 'pruneLifecycleOutbox' 'lifecycle outbox pruning exists'
check_contains src/memory/governance.ts 'recallForContext' 'context recall orchestration exists'
check_contains src/memory/governance.ts 'packageMemoriesForPrompt' 'prompt packaging exists'
check_contains src/memory/governance.ts 'omitReason' 'omission reasons exist'
check_contains src/memory/governance.ts 'applyResultBudget' 'result budgeting exists'
check_contains src/memory/governance.ts 'compactMemoryGovernance' 'compaction/archive path exists'
check_contains src/memory/governance.ts 'detectMemoryConflicts' 'conflict detection path exists'
check_contains src/memory/governance.ts 'getMemorySourceAttribution' 'source attribution path exists'
check_contains src/memory/governance.ts 'scoreFreshness' 'freshness scoring exists'
check_contains src/memory/governance.ts 'scoreMemoryConfidence' 'confidence scoring exists'
check_contains src/memory/governance.ts 'extractKeywordCues' 'keyword cue fallback exists'
check_contains src/memory/governance.ts 'archived.*quarantined.*suppressed.*retired' 'non-prompt statuses are represented'
check_contains src/memory/governance.ts 'retired_superseded' 'retired superseded trust exclusion exists'
check_contains src/memory/governance.ts '= ANY\(\$\{memoryIds\}::uuid\[\]\)' 'conflict counter uses typed uuid array parameter'

check_contains mcp/memory_models.py 'include_excluded: bool' 'operator retrieval override is explicit'
check_contains mcp/memory_search.py 'governance_status' 'MCP search returns governance metadata'
check_contains mcp/memory_search.py 'EXCLUDED_MEMORY_GOVERNANCE_STATUSES' 'MCP search has default exclusion list'
check_contains mcp/memory_search.py 'EXCLUDED_MEMORY_TRUST_CLASSES' 'MCP search has trust exclusion list'
check_contains mcp/memory_search.py '_memory_governance_clause\(include_excluded' 'MCP search applies governance clause'

echo ""
echo "--- TypeScript/Bun checks ---"
bun run lint
bun test src/__tests__/migrate.test.ts src/__tests__/memory-governance.test.ts

echo ""
echo "--- Python static checks ---"
python3 -m unittest tests/test_memory_search_governance.py -v

if [[ "$fail" -ne 0 ]]; then
  echo "=== MEMORY POLICY GATE FAILED ==="
  exit 1
fi

echo "=== MEMORY POLICY GATE PASSED ==="
