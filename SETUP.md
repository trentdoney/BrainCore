# BrainCore Setup Guide

## Prerequisites

- [Bun](https://bun.sh/) v1.1+ (JavaScript/TypeScript runtime)
- [PostgreSQL](https://www.postgresql.org/) 15+ with [pgvector](https://github.com/pgvector/pgvector) extension
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (optional, for explicit LLM fallback)
- Python 3.11+ with `psycopg`, `pgvector`, `requests`, `numpy` (for retrieval and helper scripts)

## Quick Setup with Docker

```bash
## Install repo dependencies
bun install
python -m venv .venv
source .venv/bin/activate
pip install 'psycopg[binary]>=3.1' psycopg-pool pyyaml numpy requests pgvector pydantic 'mcp[cli]>=1.0'

# Start PostgreSQL with pgvector (uses credentials from examples/docker-compose.yml)
docker compose -f examples/docker-compose.yml up -d

# Wait for PostgreSQL to be ready
sleep 5

# Copy .env.example and edit BRAINCORE_POSTGRES_DSN to match the
# docker-compose POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB values.
# The expected connection string format is a standard libpq URI:
#
#   $SCHEME://$USER:$PASSWORD@$HOST:$PORT/$DATABASE
#
# where $SCHEME is postgresql (see .env.example for a complete template
# and all other supported variables).
cp .env.example .env
$EDITOR .env

# Source the .env so BRAINCORE_POSTGRES_DSN is available in this shell
set -a && . ./.env && set +a

# Apply the full migration set
bun src/cli.ts migrate
```

## Manual PostgreSQL Setup

```sql
-- Create database and user
CREATE USER braincore WITH PASSWORD 'your-secure-password';
CREATE DATABASE braincore OWNER braincore;

-- Connect to database and enable pgvector
\c braincore
CREATE EXTENSION IF NOT EXISTS vector;

-- Create the preserve schema
CREATE SCHEMA IF NOT EXISTS preserve;
GRANT ALL ON SCHEMA preserve TO braincore;
```

Then set `BRAINCORE_POSTGRES_DSN` in your environment (see `.env.example` for the expected format) and run the schema migration:

```bash
bun install
python -m venv .venv
source .venv/bin/activate
pip install 'psycopg[binary]>=3.1' psycopg-pool pyyaml numpy requests pgvector pydantic 'mcp[cli]>=1.0'
bun src/cli.ts migrate
```

## Optional example project seed

If you want a small project scaffold for local exploration, load the example seed after the main migration path:

```bash
cp sql/004_seed_projects.example.sql /tmp/braincore-seed-projects.sql
$EDITOR /tmp/braincore-seed-projects.sql
psql "$BRAINCORE_POSTGRES_DSN" -f /tmp/braincore-seed-projects.sql
```

## Configuration

```bash
cp .env.example .env
# Edit .env with your values
```

Key configuration:
- `BRAINCORE_POSTGRES_DSN` — PostgreSQL connection string (required). See `.env.example` for format.
- `BRAINCORE_VLLM_ENDPOINTS` — Local vLLM endpoints for semantic extraction
- `BRAINCORE_EMBED_URL` — Embedding service URL (384-dim vectors)
- `BRAINCORE_KNOWN_DEVICES` — Your device names for entity extraction

## Embedding Service

BrainCore uses 384-dimensional embeddings (compatible with `all-MiniLM-L6-v2`). You need an embedding service that accepts:

```
POST /embed
{"texts": ["text to embed"]}
=> {"embeddings": [[0.1, 0.2, ...]], "model": "...", "dim": 384}
```

Options:
- [TEI](https://github.com/huggingface/text-embeddings-inference) with `sentence-transformers/all-MiniLM-L6-v2`
- Any endpoint that implements the `/embed` contract above

## Local LLM (Optional)

For semantic extraction, BrainCore uses vLLM with an OpenAI-compatible API. If no vLLM endpoint is available, semantic extraction stops unless you explicitly set `BRAINCORE_ALLOW_EXTERNAL_LLM_FALLBACK=1` or run the CLI path with `--use-claude`.

## Python Dependencies (for scripts)

```bash
pip install -r mcp/requirements.txt
pip install -r examples/mcp_server/requirements.txt
pip install pytest pyyaml psycopg-pool numpy requests pgvector
```

## Nightly Pipeline

Set up a cron job for the nightly pipeline:
```bash
# Edit your crontab
crontab -e

# Add (runs at 2:40 AM daily):
40 2 * * * /path/to/braincore/cron/nightly.sh
```

## Verify Installation

```bash
# Check database connection
bun src/cli.ts maintenance --stats

# Check vLLM health
bun src/cli.ts health-check

# Run smoke test
bash scripts/smoke-test.sh
```
