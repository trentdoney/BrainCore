# BrainCore Security

## Secret Redaction

BrainCore includes a built-in secret scanner (`src/security/secret-scanner.ts`) that automatically redacts sensitive content before any text reaches LLM endpoints. Detected patterns include:

- API keys and tokens
- Passwords and connection strings
- Private keys (RSA, EC, DSA)
- Cloud provider secrets (AWS, vendor keys)
- GitHub personal access tokens

All redacted content is replaced with `[REDACTED:<type>]` markers.

## Data Isolation

- All data is stored locally in PostgreSQL — nothing is sent to external services except:
  - **vLLM endpoints** (local by default) for semantic extraction
  - **Claude CLI** (optional fallback) for semantic extraction when vLLM is unavailable
  - **Telegram API** (optional) for pipeline notifications
  - **Grafana API** (optional, local) for alert extraction
- Embedding generation happens locally via your configured endpoint
- The nightly pipeline runs entirely on your infrastructure

## Credentials

- Database credentials should be stored in `.env` (gitignored)
- Never commit `.env` files
- Use environment variables for all secrets
- The `.env.example` file contains no real credentials

## File Permissions

- The `data/` directory contains extracted knowledge — restrict access appropriately
- Archive files may contain full incident content — treat with same sensitivity as source data
- Published markdown notes in `data/memory/` are derivative — still handle with care

## Trust Classes

BrainCore assigns trust levels to all extracted facts:

| Class | Trust Level | Source |
|-------|-------------|--------|
| `deterministic` | Highest | Parsed directly from logs/YAML — no LLM involved |
| `human_curated` | High | Operator-approved or agent-curated knowledge |
| `corroborated_llm` | Medium | LLM-extracted, confirmed by multiple sources |
| `single_source_llm` | Low | LLM-extracted from a single source |

Consumers should filter by assertion class based on their reliability requirements.

## Network Security

- By default, all services run on localhost
- No ports are exposed externally
- SSH is not required (unlike some previous architectures)
- Configure firewall rules if exposing any endpoints
