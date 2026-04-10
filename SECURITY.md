# BrainCore Security

BrainCore is designed to keep operational history useful without
exposing private infrastructure by default.

## Secrets and identifiers

- Do not commit secrets, tokens, passwords, or connection strings.
- Do not commit home paths, private IPs, or hostnames that identify the
  local lab.
- Do not add downstream project names or internal-only service names to
  public docs unless they are already part of the shipped surface.

## Data handling

- Archive and memory output can contain sensitive operational context.
- Treat `preserve.*` data, benchmark JSON, and generated notes as
  sensitive until you know they are safe to share.
- Prefer local processing and local storage for operational data.

## LLM and embedding calls

- Use environment variables for all endpoints and credentials.
- The retrieval library should degrade safely if the embedder is
  unavailable.
- The example MCP server should stay importable without a live database.

## Reporting issues

If you find a security issue, report it with enough detail to reproduce
the problem, but do not include secrets in the report. Include:

- affected file or command
- expected behavior
- observed behavior
- whether the issue affects the public launch surface

Prefer GitHub private vulnerability reporting for the public repo. If
that path is unavailable, use the maintainer contact listed in the
repository settings and keep the report private until triaged.

## Supported versions

BrainCore documents `PostgreSQL 15+ (tested on 16)` for the launch
surface.

## Reference

This repo follows the spirit of Contributor Covenant v2.1 for
interaction norms: be respectful, avoid harassment, and keep review
discussion focused on the work.
