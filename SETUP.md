# BrainCore Setup Guide

## Prerequisites

- [Bun](https://bun.sh/) v1.1+ (JavaScript/TypeScript runtime)
- [PostgreSQL](https://www.postgresql.org/) 15+ with [pgvector](https://github.com/pgvector/pgvector) extension
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (optional, for LLM fallback)
- Python 3.10+ with `psycopg`, `pgvector`, `requests`, `numpy` (for embedding scripts)

## Quick Setup with Docker

```bash
# Start PostgreSQL with pgvector
docker compose -f examples/docker-compose.yml up -d

# Wait for PostgreSQL to be ready
sleep 5

# Initialize schema
psql postgresql://braincore:braincore@localhost:5432/braincore \
  -f sql/001_preserve_schema.sql

# Seed entities (customize first)
psql postgresql://braincore:braincore@localhost:5432/braincore \
  -f sql/003_seed_entities.sql

# Optionally seed example projects
cp sql/004_seed_projects.example.sql sql/004_seed_projects.sql
# Edit sql/004_seed_projects.sql with your projects
psql postgresql://braincore:braincore@localhost:5432/braincore \
  -f sql/004_seed_projects.sql
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

Then run the schema migration:
```bash
psql "$BRAINCORE_POSTGRES_DSN" -f sql/001_preserve_schema.sql
```

## Install Dependencies

```bash
bun install
```

## Configuration

```bash
cp .env.example .env
# Edit .env with your values
```

Key configuration:
- `BRAINCORE_POSTGRES_DSN` — PostgreSQL connection string (required)
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
- Any OpenAI-compatible embedding endpoint

## Local LLM (Optional)

For semantic extraction, BrainCore uses vLLM with OpenAI-compatible API. If no vLLM endpoint is available, it automatically falls back to Claude CLI.

## Python Dependencies (for scripts)

```bash
pip install psycopg[binary] pgvector requests numpy
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
bun src/cli.ts scan --lead-window 0

# Check vLLM health
bun src/cli.ts health-check

# Run smoke test
bash scripts/smoke-test.sh
```
