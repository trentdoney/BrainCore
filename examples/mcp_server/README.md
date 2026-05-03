# Example MCP Server for BrainCore

This directory contains a reference stdio MCP server built on the
BrainCore retrieval library. It exposes the reference tools from
`mcp/memory_search.py`: `memory-search`, `memory-timeline`,
`memory-before-after`, `memory-causal-chain`, and
`memory-search-procedure`, plus visual metadata and working-memory
session tools. It also exposes lifecycle admin tools for outbox intake,
target-status overlays, feedback, stats, retry, and context recall audit. It is
still intentionally small: one transport, lazy database connection setup,
and no deployment-specific policy layer.

The working-memory and lifecycle tools can write task-session, ephemeral
memory, lifecycle outbox, lifecycle intelligence, feedback, and audit
rows. Keep this example on stdio or behind a deployment-specific
authentication and tenant-policy layer; do not expose it as a remote MCP
service without a separate write-tool review.

> **Admin-only warning**
>
> Lifecycle write tools such as `lifecycle-event-enqueue`,
> `memory-lifecycle-status-set`, `memory-lifecycle-feedback-record`, and
> `context-recall-audit-record` are trusted operator surfaces. They require
> authentication, authorization, tenant policy, and network binding controls
> before use behind any remote transport.

## Prerequisites

- Python 3.11 or newer
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

The example intentionally follows the repository-wide Python 3.11+
support floor. Its NumPy dependency may use the 2.4.x line because that
line requires Python 3.11 or newer.

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

## Tools

### `memory-search`

- **Name**: `memory-search`
- **Description**: hybrid retrieval over the preserve schema: SQL, FTS,
  vector, and temporal streams plus optional graph-path retrieval, fused
  with RRF. Returns facts, memories, segments, and episodes.
- **Input schema** (7 arguments):
  - `query` (string, required) — natural-language search string
  - `limit` (integer, default `10`, range `1`-`100`) — maximum results
  - `type_filter` (string, optional) — one of `fact`, `memory`, `segment`,
    `episode`, `procedure`, `media_artifact`, `visual_region`
    (`memory` still uses the legacy vector path in this release; no
    `embedding_index` memory role is populated yet)
  - `as_of` (string, optional) — ISO-8601 timestamp for temporal filtering
  - `scope` (string, optional) — scope-path prefix filter
  - `include_graph` (boolean, default `false`) — include graph-path retrieval
  - `explain_paths` (boolean, default `false`) — include graph path explanations
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

### Event and Procedure Tools

The same server also exposes:

- `memory-timeline` for event-frame timeline reads.
- `memory-before-after` for nearest event frames around a timestamp.
- `memory-causal-chain` for episode-grouped causal event sequences.
- `memory-search-procedure` for evidence-grounded procedure retrieval.
- `memory-next-step` for the next procedure step after a completed-step
  count.
- `memory-what-did-we-try` for prior tried procedure steps.
- `memory-failed-remediations` for prior failed remediation steps.
- `memory-search-visual` for OCR, caption, and layout metadata. It
  returns metadata and linked IDs, not raw artifact paths or file bytes.

### Working-Memory Tools

The server also exposes active task-session operations:

- `memory-session-start` to start or resume a session.
- `memory-session-update` to update session status, title, or scope.
- `memory-session-close` to close a session as completed or failed.
- `memory-session-list-active` to list active non-expired sessions.
- `memory-working-add` to add an ephemeral item with a default 14-day TTL.
- `memory-working-list` to list non-expired items by default.
- `memory-working-mark-promotion-candidate` to mark evidence-backed items
  from closed sessions for durable promotion review.
- `memory-working-cleanup-expired` to mark expired unpromoted items as
  expired without deleting promoted evidence.

### Lifecycle Admin Tools

The server exposes the CLI/MCP-first lifecycle admin surface:

- `lifecycle-event-enqueue` to enqueue idempotent lifecycle events.
- `lifecycle-event-list` to inspect the outbox.
- `lifecycle-event-retry` to retry failed or dead-letter events.
- `lifecycle-intelligence-backfill` to create overlay rows for existing
  tenant-local targets.
- `lifecycle-stats` to inspect lifecycle counts.
- `memory-lifecycle-status-set` to set target lifecycle overlay status.
- `memory-lifecycle-feedback-record` to append feedback and audit rows.
- `context-recall-audit-record` to record recall package metadata.

These tools validate target kinds, statuses, event types, target pairing, and
native target existence before writing. They update lifecycle overlay/audit
tables only; they do not directly mutate `fact`, `memory`, `procedure`,
`event_frame`, or `working_memory` truth columns.

## What this example does NOT include

This example does not include deployment-specific authorization,
tenant-routing policy, write-side ingestion, OCR, visual parsing, or
model-runtime automation. Build those on top of the `mcp.memory_search`
and `mcp.memory_models` modules for your environment. The visual search
tool only reads existing metadata rows. The connection pool in this
example is created lazily on the first tool call, which keeps the module
importable in environments where `BRAINCORE_POSTGRES_DSN` is not set.

## PostgreSQL 15+ (tested on 16)

The retrieval library targets PostgreSQL 15 or newer, and the BrainCore
project tests against `pgvector/pgvector:pg16`. Earlier major versions
are not supported because the preserve schema uses features introduced
in Postgres 15.
