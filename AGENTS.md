# AGENTS.md - BrainCore
Instructions for agents working in the BrainCore repo.

## What ships

- `src/` is the Bun write path.
- `mcp/` is the Python retrieval library.
- `examples/mcp_server/` is a minimal reference server.
- `benchmarks/` holds smoke and production benchmark artifacts.
- `README.md` is the public launch surface.

## What to avoid

- Do not claim the repo ships a large MCP tool suite.
- Do not reference private hosts, home paths, or secrets.
- Do not edit user-written prose without permission.
- Do not use placeholder metrics or dead links in public docs.

## Repo rules

1. Read before modifying.
2. Keep changes scoped to the requested files.
3. Verify before claiming completion.
4. Keep launch docs honest about smoke vs production benchmark framing.
5. Keep the incident bundle current when launch status changes.

## Human-readable boundaries

- The example MCP server is a reference implementation only.
- The public README should describe the repo as a retrieval library
  plus an example server.
- Production-corpus metrics and smoke-regression metrics are not
  interchangeable.

## Safety

- Keep secrets out of tracked files.
- Keep private network details out of public docs.

## Notes for agents

If you need more context, read `README.md`, `ARCHITECTURE.md`, and
`benchmarks/README.md` before changing anything else.
