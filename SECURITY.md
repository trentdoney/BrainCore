# BrainCore Security

BrainCore is designed to keep operational history useful without
exposing private infrastructure by default.

## Secrets and identifiers

- Do not commit secrets, tokens, passwords, or connection strings.
- The built-in scanner redacts API keys, bearer tokens, JWTs,
  cookie/session secrets, connection strings, private keys, GitHub
  tokens, and common cloud/vendor keys before semantic LLM transport
  and publish output.
- Do not put secrets in retrieval queries. If `BRAINCORE_EMBED_URL` is
  configured, the Python embedder sends query text to that endpoint.
- Do not commit home paths, private IPs, or hostnames that identify the
  local lab.
- Do not add downstream project names or internal-only service names to
  public docs unless they are already part of the shipped surface.

## Data handling

- Archive and memory output can contain sensitive operational context.
- Treat `preserve.*` data, benchmark JSON, and generated notes as
  sensitive until you know they are safe to share.
- Prefer local processing and local storage for operational data.

## Database posture

BrainCore's default posture is local, single-tenant PostgreSQL for one
operator or one deployment boundary.

- `BRAINCORE_TENANT` defaults to `default`.
- The schema has tenant columns and tenant-scoped uniqueness constraints
  for shared deployments.
- Shared deployments must apply the tenant migrations and keep all read
  and write paths scoped to the active tenant.
- Tenant isolation is app-enforced by query filters plus tenant-scoped
  constraints. The public schema does not currently implement PostgreSQL
  Row Level Security, so do not claim RLS isolation unless you add and
  verify RLS policies.
- Do not expose the database directly to untrusted clients. Put any
  network API or MCP wrapper in front of it with authentication and
  authorization.

## LLM and embedding calls

- Use environment variables for all endpoints and credentials.
- The retrieval library should degrade safely if the embedder is
  unavailable.
- The example MCP server should stay importable without a live database.
- Semantic extraction sends redacted prompts to configured LLM backends.
  If all configured vLLM endpoints are unhealthy, the TypeScript LLM
  client does not use the Claude CLI unless
  `BRAINCORE_ALLOW_EXTERNAL_LLM_FALLBACK=1` is set or the operator uses
  the explicit `--use-claude` path.
- Run extraction with `--skip-semantic` or restrict egress if no external
  LLM transport is allowed.
- The Python embedder only makes HTTP calls when `BRAINCORE_EMBED_URL`
  is explicitly set; otherwise it returns a zero vector and retrieval
  continues without vector contribution.

## MCP and network wrappers

The repo ships a retrieval library and a stdio example MCP server, not a
hardened multi-tenant network service. Any HTTP, SSE, WebSocket, or
remote MCP wrapper must provide:

- authentication before tool access
- per-process or per-request tenant binding
- tenant-scoped database queries
- input validation for `query`, `scope`, `type_filter`, and `limit`
- rate limits and request timeouts
- TLS or a trusted local/private transport
- no raw artifact or segment disclosure unless that tool is explicitly
  designed and reviewed

## Publish-output privacy

Published markdown is derived state and can be copied outside the
database boundary. Treat it as sensitive by default.

- `publish-notes` redacts recognized secrets from titles, descriptions,
  narratives, entity names, scope paths, and generated filenames before
  writing markdown.
- Redaction is pattern-based and not a substitute for human review.
- Review generated notes before sharing them outside the deployment.
- Paths, project names, hostnames, and incident names can still identify
  private infrastructure even when credentials are redacted.

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

## Review Queue

BrainCore queues pending human review when semantic extraction reports:

- `verify_warning`
- `redaction_detected`
- `semantic_truncated`
- `prompt_injection_suspected`
- `high_risk_fact_kind`
- `source_too_large`

Large artifacts can be registered and preserved without full extraction; they are marked for review instead of being pushed through the semantic path.

## Reference

This repo follows the spirit of Contributor Covenant v2.1 for
interaction norms: be respectful, avoid harassment, and keep review
discussion focused on the work.
