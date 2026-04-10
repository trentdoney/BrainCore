# Contributing to BrainCore

BrainCore is a public repo, so contributions need to stay honest about
what the repo actually ships:

- `src/` owns the Bun write path.
- `mcp/` owns the Python retrieval library.
- `examples/mcp_server/` is a minimal reference server, not the full
  downstream deployment.
- `benchmarks/` contains smoke and production artifacts with different
  framing rules.

## Before you open a PR

1. Read the current `README.md`, `ARCHITECTURE.md`, and
   `benchmarks/README.md`.
2. Run the launch checks that apply to your change.
3. Keep private infrastructure, hostnames, home paths, and secrets out
   of the diff.
4. Do not turn the example MCP server into a claim that the repo ships a
   larger tool surface than it does.
5. Keep the launch truth surface aligned: `001` through `008`,
   `14-table preserve schema`, `v1.1.4`, and the committed benchmark
   artifacts.

## Required checks

Run the checks relevant to your change before you ask for review:

```bash
bash scripts/pre-push-gate.sh
python benchmarks/verify_claims_to_evidence.py --self-test
python benchmarks/verify_tool_index.py --self-test
```

If you touched migrations or schema-adjacent docs, also verify the fresh
install path with `bun src/cli.ts migrate` against a clean database and
confirm the preserve table count, `eval_run`, and `eval_case` are
present. If the command fails, fix the command or the migration set
rather than documenting a workaround.

## What to keep stable

- Public docs must use `PostgreSQL 15+ (tested on 16)`.
- Example-server docs must describe the minimal reference server only.
- Benchmark claims must match the correct framing file.
- Any numeric README claim must already have a row in
  `benchmarks/claims-to-evidence.yaml`.
- The public launch surface must stay dead-link-free.
- The incident bundle must be updated when launch status changes.

## Writing style

- Be direct.
- Prefer source-backed statements over marketing language.
- Use repository-relative paths in examples.
- Prefer practical setup, verification, and failure-mode guidance over
  generic OSS boilerplate.

## PR checklist

- The diff is scoped to the requested change.
- New claims are backed by evidence files.
- Sanitization passes.
- The docs still reflect the repo as shipped.
