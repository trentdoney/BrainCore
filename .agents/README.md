# BrainCore agent surface

This directory is the public agent-discoverability surface for the
launch repo.

## Tool index

- [`TOOL_INDEX.yaml`](TOOL_INDEX.yaml) lists the tools that ship in the
  example MCP server.

## Working rules

- Keep tool names aligned with `examples/mcp_server/server.py`.
- Do not add tools here unless they are actually shipped in the public
  surface.
- Keep the directory free of private hostnames, paths, and secrets.
