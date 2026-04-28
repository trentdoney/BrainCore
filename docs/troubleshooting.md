# BrainCore Troubleshooting

This guide covers the public launch surface. If a failure is not listed
here, update this document after you find the root cause.

## Fresh clone fails during install

The supported launch path is `bun src/cli.ts migrate`.

If that fails:

- verify `BRAINCORE_POSTGRES_DSN` points at the intended database
- confirm the database is reachable from the current host
- inspect `preserve.schema_migration` for applied migration records and
  checksum mismatches
- inspect the first migration error, not the last one
- confirm the database is empty enough for a full bootstrap

After a successful install, the schema should report 38 preserve tables
and both `preserve.eval_run` and `preserve.eval_case` should exist. The
application host does not need the `psql` binary for `bun src/cli.ts migrate`;
the runner applies SQL through the configured PostgreSQL connection.

## Example MCP server import fails

The example server is a stdio integration for the retrieval library, not
a hardened remote appliance.

Check:

- you are running from the BrainCore checkout
- `BRAINCORE_POSTGRES_DSN` is set only when you actually invoke the tool
- the repo-root `mcp/` package is present
- the local Python environment can import `mcp.memory_search`

## Vector search behaves like it is missing

If retrieval works but vector candidates stay at zero:

- confirm `BRAINCORE_EMBED_URL` is set
- confirm the embedder returns 384-dimensional vectors
- confirm the embedder is not falling back to a zero vector

BrainCore still functions without vector search, but the ranking mix
changes.

## Benchmark mismatch

Do not mix smoke-regression and production-corpus artifacts.

- `benchmarks/results/2026-04-09-retrieval.json` is synthetic smoke
- `benchmarks/results/2026-04-09-grounding.json` is synthetic smoke
- `benchmarks/results/2026-04-09-retrieval-production.json` is live-corpus retrieval
- `benchmarks/results/2026-04-09-grounding-production.json` is live-corpus grounding

If the README claim does not match the right file, the claims gate
should fail.

## Sanitization gate fails

If `scripts/pre-push-gate.sh` fails, look for:

- private IPs
- home paths
- hostnames
- secrets
- downstream project names
- inline PostgreSQL DSNs

Fix the source file rather than adding a gate exception.

## Eval command fails

`bun src/cli.ts eval --run` needs both `preserve.eval_run` and
`preserve.eval_case`. If either table is missing, the migration set is
incomplete.
