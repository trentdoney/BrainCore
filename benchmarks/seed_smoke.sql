-- ============================================================================
-- seed_smoke.sql — synthetic smoke-test fixture for BrainCore retrieval bench
-- ============================================================================
--
-- WHAT: a minimal self-contained SQL fixture that populates preserve.entity,
-- preserve.fact, preserve.fact_evidence, preserve.artifact, preserve.segment,
-- preserve.extraction_run, and preserve.memory with just enough rows (9
-- facts, 12 entities, 15 published memories, 5 fact_evidence rows) to
-- exercise BrainCore's 4-stream hybrid retrieval pipeline end-to-end on a
-- clean clone. Auto-loaded by benchmarks/run_retrieval.py when preserve.fact
-- is empty; can be re-applied via `--force-seed`.
--
-- WHY: BrainCore's `bun src/cli.ts scan` subcommand is NOT implemented as of
-- v1.1.3 (it prints help and exits), so there is no real ingestion path from
-- examples/sample-vault/ into preserve.* on a fresh clone. This file supplies
-- the post-extraction smoke-test baseline directly, so the retrieval pipeline
-- can be validated without the parser/extractor pipeline being runnable.
--
-- WHAT IT IS NOT:
--   - NOT production data. Every row is synthetic, crafted to light up the
--     retrieval streams against the 12 canonical queries.
--   - NOT a quality benchmark. The committed relevance_at_10 = 0.4167 is the
--     contract value for THIS fixture only — not a measure of BrainCore's
--     retrieval quality in any real deployment.
--   - NOT exercised through the real parser/extractor. The post-extraction
--     state is INSERTed directly; the extract pipeline is skipped.
--   - NOT representative of corpus numbers in any production BrainCore
--     deployment (which typically has 10k+ facts).
--
-- LEGITIMACY NOTE
-- ===============
-- This seed is a CIRCULAR smoke benchmark: the 9 facts, 15 memories, and
-- 12 canonical queries are tuned TOGETHER so that exactly 5 of 12 queries
-- hit under plainto_tsquery AND-set + title_contains substring checks,
-- producing quality.relevance_at_10 = 0.4167 deterministically.
--
-- This number is useful as a pipeline-regression signal: if the runner,
-- retrieval library, or preserve schema regresses, the expected score
-- drops and the gate fires. It is NOT a representative measurement of
-- BrainCore's retrieval quality on arbitrary workloads. Do not cite
-- 0.4167 as a performance claim in any README, blog post, paper, or
-- marketing material. The public README's headline retrieval metrics
-- (26,947 facts / P50 22.5ms / P95 25.3ms / etc.) must come from a
-- separate production-corpus benchmark run against a naturally-populated
-- BrainCore instance, not from this synthetic fixture.
--
-- IDEMPOTENT: wrapped in a single transaction. Every INSERT uses
-- ON CONFLICT DO NOTHING so this file is safe to re-run against an
-- already-seeded DB without raising errors.
--
-- CORPUS CONTRACT (post-seed, after migrations 001/003/004/005/006/007):
--   SELECT count(*) FROM preserve.fact                                 -- 9
--   SELECT count(*) FROM preserve.entity                               -- 12
--   SELECT count(*) FROM preserve.memory WHERE lifecycle_state='published' -- 15
--   SELECT count(*) FROM preserve.fact_evidence                        -- 5
-- run_retrieval.py should report quality.relevance_at_10 = 0.4167
-- (5 of 12 canonical queries hit top-10). The 5 hitting queries are
-- q01, q03, q05, q07, q11 — each engineered via a fact whose predicate
-- (returned as `title`) contains the expected substring and whose
-- predicate + object_value tsvector covers the full plainto_tsquery
-- AND-set for that natural-language question.
--
-- ENTITY SEEDING: migrations 003 (3 devices) + 004 (5 projects) already
-- seed 8 entities. This fixture adds 2 more devices (ON CONFLICT no-op
-- against 003's server-a / server-b) plus 4 service entities — total = 12.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Artifacts: one per synthetic incident source
-- ----------------------------------------------------------------------------
INSERT INTO preserve.artifact (
  artifact_id, source_type, source_key, original_path, sha256, size_bytes,
  preservation_state, scope_path
) VALUES
('11111111-1111-1111-1111-111111111111', 'opsvault_incident',
 'smoke-seed:inc-001', 'examples/sample-vault/incidents/INC-001/notes.md',
 repeat('a', 64), 2048, 'published', 'device:server-a/incidents/INC-001'),
('22222222-2222-2222-2222-222222222222', 'opsvault_incident',
 'smoke-seed:inc-002', 'examples/sample-vault/incidents/INC-002/notes.md',
 repeat('b', 64), 3072, 'published', 'device:server-a/incidents/INC-002'),
('33333333-3333-3333-3333-333333333333', 'opsvault_incident',
 'smoke-seed:inc-003', 'examples/sample-vault/incidents/INC-003/notes.md',
 repeat('c', 64), 2560, 'published', 'device:server-a/incidents/INC-003')
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Extraction runs (facts require a FK to extraction_run)
-- ----------------------------------------------------------------------------
INSERT INTO preserve.extraction_run (
  run_id, artifact_id, pipeline_version, model_name, prompt_version,
  status, started_at, finished_at
) VALUES
('00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
 'smoke-seed', 'synthetic', 'v0', 'success', now(), now()),
('00000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
 'smoke-seed', 'synthetic', 'v0', 'success', now(), now()),
('00000000-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333',
 'smoke-seed', 'synthetic', 'v0', 'success', now(), now())
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. Segments (required by fact_evidence FK)
-- ----------------------------------------------------------------------------
INSERT INTO preserve.segment (
  segment_id, artifact_id, ordinal, content, source_sha256, source_relpath
) VALUES
('11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111',
 1, 'docker daemon exhausted disk space on server-a due to unrotated container logs',
 repeat('a',64), 'incidents/INC-001/notes.md'),
('22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222',
 1, 'postgresql replication lag on server-b caused by long-running analytical query blocking WAL replay',
 repeat('b',64), 'incidents/INC-002/notes.md'),
('33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333',
 1, 'nginx returned 502 errors on server-a after lets encrypt certificate expired; certbot auto-renewal restored service',
 repeat('c',64), 'incidents/INC-003/notes.md')
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. Entities (devices + services). 003_seed_entities.sql already seeded
--    3 devices and 004_seed_projects.example.sql already seeded 5 projects;
--    ON CONFLICT DO NOTHING keeps the device inserts idempotent.
-- ----------------------------------------------------------------------------
INSERT INTO preserve.entity (entity_id, entity_type, canonical_name, aliases, attrs) VALUES
('d0000000-0000-0000-0000-00000000000a', 'device', 'server-a', '["host:server-a"]'::jsonb, '{}'::jsonb),
('d0000000-0000-0000-0000-00000000000b', 'device', 'server-b', '["host:server-b"]'::jsonb, '{}'::jsonb),
('50000000-0000-0000-0000-000000000001', 'service', 'docker', '[]'::jsonb, '{}'::jsonb),
('50000000-0000-0000-0000-000000000002', 'service', 'postgresql', '["postgres","pg"]'::jsonb, '{}'::jsonb),
('50000000-0000-0000-0000-000000000003', 'service', 'nginx', '[]'::jsonb, '{}'::jsonb),
('50000000-0000-0000-0000-000000000004', 'service', 'api', '[]'::jsonb, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 5. Facts. The predicate column is returned as `title` by
--    memory_search's FTS stream and must contain the substring checked
--    by the canonical query matcher. The fts column is a generated
--    tsvector over (predicate || ' ' || object_value::text), so we
--    stuff the additional keywords needed to satisfy
--    `plainto_tsquery('english', <query_text>)` AND-semantics into the
--    object_value JSONB "note" field.
--
--    Five facts (marked [q01..q11]) are engineered to cause five of the
--    twelve canonical queries to match their expected_top_k:
--      q01 via ffffffff-0001-0001-0001-000000000001 (predicate contains "docker")
--      q03 via ffffffff-0001-0001-0001-000000000002 (predicate contains "log rotation")
--      q05 via ffffffff-0002-0002-0002-000000000001 (predicate contains "replication")
--      q07 via ffffffff-0002-0002-0002-000000000002 (predicate contains "max_standby_streaming_delay")
--      q11 via ffffffff-0003-0003-0003-000000000002 (predicate contains "auto-renewal")
--    The remaining four facts are observation/context rows that do not
--    target a canonical query directly.
-- ----------------------------------------------------------------------------
INSERT INTO preserve.fact (
  fact_id, subject_entity_id, predicate, object_value, fact_kind, confidence,
  valid_from, canonical_fingerprint, created_run_id, scope_path
) VALUES
-- [q01] INC-001 cause fact — predicate contains "docker"; object_value packs
-- all q01 stems: caus, docker, daemon, run, disk, space, server, server-a
('ffffffff-0001-0001-0001-000000000001',
 '50000000-0000-0000-0000-000000000001',  -- docker
 'docker daemon disk space exhaustion',
 '{"note":"root cause of this outage was that the docker daemon kept running out of disk space on server-a when unrotated container logs filled storage"}'::jsonb,
 'cause', 0.95, '2026-01-15T08:00:00Z', 'fp-inc001-cause-1',
 '00000000-0000-0000-0000-000000000001', 'device:server-a'),
-- [q03] INC-001 remediation fact — predicate contains "log rotation";
-- object_value packs all q03 stems: remedi, unrot, docker, contain, log, issu
('ffffffff-0001-0001-0001-000000000002',
 '50000000-0000-0000-0000-000000000001',  -- docker
 'log rotation remediation for docker container logs',
 '{"note":"we remediated the unrotated docker container logs issue by configuring the json-file driver with max-size and max-file"}'::jsonb,
 'remediation', 0.90, '2026-01-15T10:00:00Z', 'fp-inc001-fix-1',
 '00000000-0000-0000-0000-000000000001', 'device:server-a'),
-- [q05] INC-002 cause fact — predicate contains "replication";
-- object_value packs all q05 stems: root, caus, postgresql, replic, lag, incid
('ffffffff-0002-0002-0002-000000000001',
 '50000000-0000-0000-0000-000000000002',  -- postgresql
 'postgresql replication lag incident root cause',
 '{"note":"the root cause of the postgresql replication lag incident on server-b was a long-running analytical query blocking WAL replay"}'::jsonb,
 'cause', 0.95, '2026-02-01T12:00:00Z', 'fp-inc002-cause-1',
 '00000000-0000-0000-0000-000000000002', 'device:server-b'),
-- [q07] INC-002 remediation fact — predicate contains "max_standby_streaming_delay";
-- object_value packs all q07 stems: fix, long-run, analyt, queri, block, wal, replay
('ffffffff-0002-0002-0002-000000000002',
 '50000000-0000-0000-0000-000000000002',  -- postgresql
 'max_standby_streaming_delay raised to fix long-running analytical query blocking WAL replay',
 '{"note":"we fixed the long-running analytical query blocking WAL replay by raising max_standby_streaming_delay to 300s on the replica"}'::jsonb,
 'remediation', 0.90, '2026-02-01T14:00:00Z', 'fp-inc002-fix-1',
 '00000000-0000-0000-0000-000000000002', 'device:server-b'),
-- INC-003 cause fact (un-engineered; kept as a non-targeted observation)
('ffffffff-0003-0003-0003-000000000001',
 '50000000-0000-0000-0000-000000000003',  -- nginx
 'certificate expired causing 502 errors on server-a',
 '{"note":"lets encrypt cert expired 2026-02-15"}'::jsonb,
 'cause', 0.95, '2026-02-15T09:00:00Z', 'fp-inc003-cause-1',
 '00000000-0000-0000-0000-000000000003', 'device:server-a'),
-- [q11] INC-003 remediation fact — predicate contains "auto-renewal";
-- object_value packs all q11 stems: autom, certif, renew, nginx, outag
('ffffffff-0003-0003-0003-000000000002',
 '50000000-0000-0000-0000-000000000003',  -- nginx
 'certbot auto-renewal automated certificate renewal after nginx outage',
 '{"note":"after the nginx outage we automated certificate renewal by enabling the certbot systemd timer so certificates renew automatically"}'::jsonb,
 'remediation', 0.90, '2026-02-15T10:30:00Z', 'fp-inc003-fix-1',
 '00000000-0000-0000-0000-000000000003', 'device:server-a'),
-- Three event facts to round out the 9-fact contract. All three use
-- service entities (docker / postgresql / api) whose UUIDs are explicitly
-- inserted above, avoiding any dependency on the auto-generated UUIDs
-- for server-a / server-b from migration 003_seed_entities.sql.
('ffffffff-0004-0004-0004-000000000001',
 '50000000-0000-0000-0000-000000000001',  -- docker
 'disk space recovered after docker log rotation rollout',
 '{"note":"free space restored after log rotation went live on the host"}'::jsonb,
 'event', 0.85, '2026-01-16T08:00:00Z', 'fp-inc001-obs-1',
 '00000000-0000-0000-0000-000000000001', 'device:server-a'),
('ffffffff-0005-0005-0005-000000000001',
 '50000000-0000-0000-0000-000000000002',  -- postgresql
 'postgresql replica caught up after WAL backlog drained',
 '{"note":"replication lag back to under one second"}'::jsonb,
 'event', 0.85, '2026-02-02T10:00:00Z', 'fp-inc002-obs-1',
 '00000000-0000-0000-0000-000000000002', 'device:server-b'),
('ffffffff-0006-0006-0006-000000000001',
 '50000000-0000-0000-0000-000000000004',  -- api
 'api latency returned to baseline after nginx certificate renewal',
 '{"note":"p95 latency back to 120ms after nginx cert renewal"}'::jsonb,
 'event', 0.85, '2026-02-15T11:00:00Z', 'fp-inc003-obs-1',
 '00000000-0000-0000-0000-000000000003', 'device:server-a')
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 6. Fact evidence rows for 5 out of 9 facts
-- ----------------------------------------------------------------------------
INSERT INTO preserve.fact_evidence (
  fact_id, segment_id, excerpt, extraction_method, source_sha256,
  source_relpath, excerpt_hash
) VALUES
('ffffffff-0001-0001-0001-000000000001', '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
 'docker daemon exhausted disk space on server-a due to unrotated container logs',
 'rule', repeat('a',64), 'incidents/INC-001/notes.md', 'h1'),
('ffffffff-0001-0001-0001-000000000002', '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
 'log rotation added to docker daemon.json', 'human_curated',
 repeat('a',64), 'incidents/INC-001/notes.md', 'h2'),
('ffffffff-0002-0002-0002-000000000001', '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
 'replication lag caused by long-running analytical query', 'rule',
 repeat('b',64), 'incidents/INC-002/notes.md', 'h3'),
('ffffffff-0002-0002-0002-000000000002', '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
 'max_standby_streaming_delay raised on replica', 'llm',
 repeat('b',64), 'incidents/INC-002/notes.md', 'h4'),
('ffffffff-0003-0003-0003-000000000001', '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
 'lets encrypt certificate expired causing nginx 502', 'rule',
 repeat('c',64), 'incidents/INC-003/notes.md', 'h5')
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 7. Published memories. title + narrative is FTS-indexed via a stored
--    generated column and participates in the memory FTS stream.
--    lifecycle_state='published' gates which rows are eligible.
-- ----------------------------------------------------------------------------
INSERT INTO preserve.memory (
  memory_id, memory_type, title, narrative, lifecycle_state,
  pipeline_version, model_name, prompt_version
) VALUES
('a0000000-0000-0000-0000-00000000001d', 'playbook',
 'Docker log rotation and disk management playbook',
 'Rotate container logs via json-file driver with max-size=10m, max-file=3 to prevent disk space exhaustion on docker hosts like server-a.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000002d', 'playbook',
 'Lets Encrypt SSL certbot auto-renewal playbook',
 'Enable certbot.timer so SSL certificates renew automatically before expiration; monitor via SSL probe to avoid nginx 502 outages.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000003d', 'playbook',
 'PostgreSQL replication lag and WAL replay playbook',
 'Raise max_standby_streaming_delay on replicas and kill long-running analytical queries to unblock replication on server-b.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000004d', 'heuristic',
 'Docker daemon disk space runbook',
 'When docker consumes all disk space on a host, prune stopped containers and rotate json-file logs; verify free space via disk usage inspection.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000005d', 'heuristic',
 'PostgreSQL replica WAL replay runbook',
 'Check pg_stat_replication on the primary and pg_stat_wal_receiver on the replica when replication lag spikes; WAL replay may be blocked by long-running queries.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000006d', 'heuristic',
 'Nginx 502 diagnosis runbook',
 'When nginx returns 502 bad gateway, check upstream certificate validity first — expired SSL certificates on the upstream are a common cause.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000007d', 'entity_summary',
 'INC-001 postmortem: docker disk exhaustion on server-a',
 'Root cause: unrotated container logs filled container storage. Fix: json-file log rotation with max-size 10m. Prevention: add disk-usage alert.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000008d', 'entity_summary',
 'INC-002 postmortem: postgresql replication lag on server-b',
 'Root cause: long-running analytical query blocked WAL replay. Fix: raised max_standby_streaming_delay to 300s. Prevention: query timeout on replicas.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000009d', 'entity_summary',
 'INC-003 postmortem: nginx 502 due to expired SSL certificate',
 'Root cause: lets encrypt certificate expired on server-a. Fix: renewed cert and enabled certbot.timer. Prevention: SSL expiry probe.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000010d', 'pattern',
 'Docker json-file log driver reference',
 'The json-file driver supports max-size and max-file options to cap container log growth. Default is unlimited.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000011d', 'pattern',
 'PostgreSQL hot standby configuration reference',
 'max_standby_streaming_delay controls how long the replica waits before cancelling queries that conflict with WAL replay.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000012d', 'pattern',
 'Certbot systemd timer reference',
 'certbot.timer runs certbot renew twice daily to renew certificates that are within 30 days of expiration.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000013d', 'heuristic',
 'Lesson: always configure log rotation on container hosts',
 'Docker hosts without log rotation run out of disk within weeks under normal workload. Configure json-file max-size at install time.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000014d', 'heuristic',
 'Lesson: query timeouts belong on replicas, not just primaries',
 'Long analytical queries on a hot standby will block WAL replay. Set statement_timeout on replicas to shed load before replication stalls.',
 'published', 'smoke-seed', 'synthetic', 'v0'),
('a0000000-0000-0000-0000-00000000015d', 'heuristic',
 'Lesson: certificate monitoring is a pre-requisite, not a nice-to-have',
 'Expired SSL certificates cause nginx 502 errors that cascade into api outages. Monitor expiry at least 14 days out and alert on it.',
 'published', 'smoke-seed', 'synthetic', 'v0')
ON CONFLICT DO NOTHING;

COMMIT;

-- ============================================================================
-- End of seed_smoke.sql
-- ============================================================================
