# Changelog

All notable changes to BrainCore are documented in this file. This public
release lists the capabilities included in the initial public release.

## [Unreleased]

### Changed
- No unreleased changes.

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
- The open-source preserve schema is documented as 38 tables after migrations
  `001` through `020` plus the runtime migration ledger bootstrap.
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
