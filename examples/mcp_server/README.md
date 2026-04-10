# Example MCP Server for BrainCore

This directory contains a minimal reference stdio MCP server built on the
BrainCore retrieval library. It exposes exactly one tool, `memory-search`,
wired directly to the single public function in `mcp/memory_search.py`. It
is intentionally small: one tool, one library function, one transport. It
is not the same server shape you would use in a larger downstream
deployment with additional tenant-aware or project-specific tools.

## Prerequisites

- Python 3.10 or newer
- A running BrainCore PostgreSQL database with the full migration set
  applied against the `preserve` schema
- The `BRAINCORE_POSTGRES_DSN` environment variable set to a libpq DSN
  pointing at that database, for example:

```bash
export BRAINCORE_POSTGRES_DSN='<libpq DSN>'
```

## Install

```bash
cd examples/mcp_server
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Run

From the repository root:

```bash
python -m examples.mcp_server.server
```

Or directly:

```bash
cd examples/mcp_server
python server.py
```

Both forms start a stdio-transport MCP server. Connect to it from an MCP
client such as Claude Desktop or MCP Inspector.

## Claude Desktop config

Add the following entry to `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on
macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "braincore-example": {
      "command": "/absolute/path/to/examples/mcp_server/venv/bin/python",
      "args": ["-m", "examples.mcp_server.server"],
      "cwd": "/absolute/path/to/BrainCore",
      "env": {
        "BRAINCORE_POSTGRES_DSN": "<libpq DSN>"
      }
    }
  }
}
```

## The `memory-search` tool

- **Name**: `memory-search`
- **Description**: 4-stream hybrid retrieval (SQL + FTS + vector +
  temporal, fused with RRF) over the preserve schema. Returns facts,
  memories, segments, and episodes.
- **Input schema** (5 arguments):
  - `query` (string, required) — natural-language search string
  - `limit` (integer, default `10`, range `1`-`100`) — maximum results
  - `type_filter` (string, optional) — one of `fact`, `memory`, `segment`, `episode`
  - `as_of` (string, optional) — ISO-8601 timestamp for temporal filtering
  - `scope` (string, optional) — scope-path prefix filter (for example `device:server-a`)
- **Output shape** (dict):
  - `results` — list of result objects (`object_id`, `object_type`,
    `title`, `summary`, `confidence`, `score`, `valid_from`, `valid_to`,
    `evidence`, `scope_path`)
  - `query_time_ms` — float, end-to-end query latency
  - `stream_counts` — dict of candidate counts per retrieval stream

Example call, as seen by the tool:

```json
{
  "query": "pgvector crash postmortem",
  "limit": 5,
  "type_filter": "fact"
}
```

## What this example does NOT include

This example is intentionally minimal: one tool, one library function,
stdio transport. If you need additional tools (state-at, timeline,
explain, embed, and so on), build them in your own server on top of the
`mcp.memory_search` and `mcp.memory_models` modules. The connection pool
in this example is created lazily on the first tool call, which keeps
the module importable in environments where `BRAINCORE_POSTGRES_DSN` is
not set.

## PostgreSQL 15+ (tested on 16)

The retrieval library targets PostgreSQL 15 or newer, and the BrainCore
project tests against `pgvector/pgvector:pg16`. Earlier major versions
are not supported because the preserve schema uses features introduced
in Postgres 15.
