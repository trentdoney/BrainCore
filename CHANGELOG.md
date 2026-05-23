# Changelog

All notable changes to BrainCore are documented in this file.

## [Unreleased]

## [1.2.0] - 2026-05-23

### Added
- Added additive memory governance migration `022_memory_governance.sql` with prompt recall, feedback, quality audit, context audit, lifecycle outbox, cue, compaction, and source attribution support.
- Added additive assistant memory source migration `023_assistant_memory_sources.sql`
  with `vestige_memory` and `pai_auto_memory` source types for deterministic
  assistant-memory migration sources.
- Added governed memory CLI commands for event ingestion, recall/read auditing, status updates, feedback, compaction, conflict detection, and source attribution.
- Added memory governance policy checks to CI and local sanitization coverage.
- Added assistant memory import review commands so imported assistant memories
  stay non-prompt-eligible until operator review and memory governance approve
  promotion.
- Added audited BrainCore snapshot builds with compact, risk, and deep preload
  profiles.
- Added BrainCore shadow-eval support for snapshot behavior checks.

### Fixed
- Governed prompt search now excludes archived, quarantined, suppressed, retired, and retired-superseded memories by default while preserving an explicit operator inspection override.
- Governed MCP search now applies the same default exclusion to facts, segments, and episodes connected to excluded memories.
- Governance conflict detection now writes to BrainCore's existing typed memory graph schema on the public repository line.

### Changed
- Added repository CODEOWNERS for `@trentdoney` and `@SynapseOpsAgent`.
- Aligned the example MCP server with the repository-wide Python 3.11+
  support floor and accepted the NumPy 2.4.x dependency line.
- Added enterprise memory lifecycle migration `021_enterprise_lifecycle.sql`,
  including lifecycle outbox, target intelligence, cues, context recall audit,
  feedback, score audit, and audit log tables.
- Added CLI and MCP-first lifecycle administration surfaces. The browser/admin
  web app remains a future upgrade path.
- The open-source preserve schema is now documented as 50 tables after
  migrations `001` through `023` plus the runtime migration ledger bootstrap.
- Lifecycle `suppressed` and `retired` overlays are enforced in retrieval and
  procedure search paths without mutating BrainCore native truth rows.
- Memory governance metadata, lifecycle sensitivity/redaction values, and cue
  scoring semantics are documented and validated at lifecycle ingestion.
- Lifecycle rollback is documented as a development/test rollback only unless
  lifecycle audit/outbox data has first been exported.

## [1.1.6] - 2026-04-30

Public readiness patch for the SynapseGrid Labs repository promotion.

### Changed
- Updated public repository links and release metadata for
  `SynapseGrid-Labs/BrainCore`.
- Updated README and GitHub presentation assets for the `v1.1.6` release
  surface.
- Updated the pinned CodeQL action SHA and the MCP example `pgvector`
  lower bound through the curated dependency gate.

### Fixed
- Hardened Codex shared ingestion against out-of-root document paths.
- Fixed YAML/frontmatter string escaping for backslashes and quoted values.
- Verified README asset manifests and public numeric claims after the visual
  refresh.

## [1.1.5] - 2026-04-28

Initial public release for BrainCore.

### Added
- Reference stdio MCP server under `examples/mcp_server/`.
- Public MCP tool index and verifier covering 17 registered tools.
- Evidence-backed benchmark claim verifier for README numeric claims.
- Migration set through `020_embedding_index_roles.sql`, including graph,
  event-frame, procedure, reflection, working-memory, multimodal, and
  embedding-index tables.
- Down migrations for all post-launch upgrade migrations that introduce new
  schema.
- Working-memory operations, procedure operational tools, event timeline tools,
  causal-chain tools, and graph retrieval helpers.
- Multimodal metadata ingestion helpers and 384-dimensional embedding-index
  role support.

### Changed
- Public docs describe four core retrieval streams plus optional graph-path
  retrieval.
- External Claude CLI fallback is explicit opt-in with
  `BRAINCORE_ALLOW_EXTERNAL_LLM_FALLBACK=1` or `--use-claude`.
- Benchmark artifacts and runners are aligned to package version `1.1.5`.
- The open-source preserve schema documentation was aligned to the migration
  set through `020_embedding_index_roles.sql`.
- Nightly extraction skips optional sources when their configuration is absent.
- Public setup examples use placeholder credentials and local-only defaults.

### Fixed
- Secret redaction coverage across TypeScript extraction/publish paths and
  Python embedding backfill.
- FastMCP tool-index verification when the repo-local `mcp/` package shadows
  the PyPI package name.
- Public test path so plain `bun test` passes on a fresh clone after
  dependencies are installed.
- Bulk archive, deterministic extract, and semantic extract scripts so summary
  counters and SQL quoting behave correctly.
- Release workflow checks now verify the benchmark artifacts it publishes.
- Source path environment variables now match the documented `.env.example`
  names.

### Removed
- Private host, path, incident, and deployment-specific references from the
  public release tree.
- Stale release-history compare links that do not apply to the public release
  tree.
