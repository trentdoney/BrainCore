-- ============================================================================
-- seed_event_timeline_smoke.sql — event-frame overlay for BrainCore timeline smoke
-- ============================================================================
--
-- Applies deterministic episode and event_frame rows on top of
-- benchmarks/seed_smoke.sql. This is intentionally separate from the existing
-- retrieval and graph smoke fixtures so timeline regression numbers do not
-- change the baseline retrieval benchmark contract.

BEGIN;

INSERT INTO preserve.episode (
  episode_id,
  episode_type,
  title,
  start_at,
  end_at,
  severity,
  outcome,
  summary,
  primary_artifact_id,
  scope_path
) VALUES
(
  'eeeeeeee-0001-0001-0001-000000000001',
  'incident',
  'INC-001 docker disk exhaustion',
  '2026-01-15T08:00:00Z',
  '2026-01-15T10:30:00Z',
  'medium',
  'resolved',
  'Docker logs filled disk until log rotation was configured.',
  '11111111-1111-1111-1111-111111111111',
  'device:server-a'
),
(
  'eeeeeeee-0002-0002-0002-000000000002',
  'incident',
  'INC-002 postgresql replication lag',
  '2026-02-01T12:00:00Z',
  '2026-02-01T14:30:00Z',
  'medium',
  'resolved',
  'A long analytical query blocked WAL replay until replica standby delay was raised.',
  '22222222-2222-2222-2222-222222222222',
  'device:server-b'
),
(
  'eeeeeeee-0003-0003-0003-000000000003',
  'incident',
  'INC-003 nginx certificate outage',
  '2026-02-15T09:00:00Z',
  '2026-02-15T10:45:00Z',
  'high',
  'resolved',
  'Nginx returned 502 after certificate expiry; certbot renewal restored service.',
  '33333333-3333-3333-3333-333333333333',
  'device:server-a'
)
ON CONFLICT DO NOTHING;

UPDATE preserve.fact
SET episode_id = CASE fact_id
  WHEN 'ffffffff-0001-0001-0001-000000000001' THEN 'eeeeeeee-0001-0001-0001-000000000001'::uuid
  WHEN 'ffffffff-0001-0001-0001-000000000002' THEN 'eeeeeeee-0001-0001-0001-000000000001'::uuid
  WHEN 'ffffffff-0002-0002-0002-000000000001' THEN 'eeeeeeee-0002-0002-0002-000000000002'::uuid
  WHEN 'ffffffff-0002-0002-0002-000000000002' THEN 'eeeeeeee-0002-0002-0002-000000000002'::uuid
  WHEN 'ffffffff-0003-0003-0003-000000000001' THEN 'eeeeeeee-0003-0003-0003-000000000003'::uuid
  WHEN 'ffffffff-0003-0003-0003-000000000002' THEN 'eeeeeeee-0003-0003-0003-000000000003'::uuid
  ELSE episode_id
END
WHERE fact_id IN (
  'ffffffff-0001-0001-0001-000000000001',
  'ffffffff-0001-0001-0001-000000000002',
  'ffffffff-0002-0002-0002-000000000001',
  'ffffffff-0002-0002-0002-000000000002',
  'ffffffff-0003-0003-0003-000000000001',
  'ffffffff-0003-0003-0003-000000000002'
);

INSERT INTO preserve.fact_evidence (
  fact_id, segment_id, excerpt, extraction_method, source_sha256,
  source_relpath, excerpt_hash
) VALUES
(
  'ffffffff-0003-0003-0003-000000000002',
  '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'certbot auto-renewal restored nginx service',
  'rule',
  repeat('c',64),
  'incidents/INC-003/notes.md',
  'h6'
)
ON CONFLICT DO NOTHING;

INSERT INTO preserve.event_frame (
  event_frame_id,
  tenant,
  frame_fingerprint,
  episode_id,
  source_fact_id,
  event_type,
  actor_entity_id,
  action,
  object_value,
  time_start,
  outcome,
  confidence,
  assertion_class,
  evidence_segment_id,
  scope_path,
  frame_json,
  created_run_id
) VALUES
(
  'ef000000-0001-0001-0001-000000000001',
  'default',
  repeat('a', 64),
  'eeeeeeee-0001-0001-0001-000000000001',
  'ffffffff-0001-0001-0001-000000000001',
  'cause',
  '50000000-0000-0000-0000-000000000001',
  'docker daemon disk space exhaustion',
  '{"note":"container logs filled disk on server-a"}'::jsonb,
  '2026-01-15T08:00:00Z',
  NULL,
  0.95,
  'deterministic',
  '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'device:server-a',
  '{"source":"synthetic-event-timeline-smoke"}'::jsonb,
  '00000000-0000-0000-0000-000000000001'
),
(
  'ef000000-0001-0001-0001-000000000002',
  'default',
  repeat('b', 64),
  'eeeeeeee-0001-0001-0001-000000000001',
  'ffffffff-0001-0001-0001-000000000002',
  'remediation',
  '50000000-0000-0000-0000-000000000001',
  'log rotation remediation for docker container logs',
  '{"note":"configured json-file max-size and max-file"}'::jsonb,
  '2026-01-15T10:00:00Z',
  'log rotation configured',
  0.90,
  'human_curated',
  '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'device:server-a',
  '{"source":"synthetic-event-timeline-smoke"}'::jsonb,
  '00000000-0000-0000-0000-000000000001'
),
(
  'ef000000-0002-0002-0002-000000000001',
  'default',
  repeat('c', 64),
  'eeeeeeee-0002-0002-0002-000000000002',
  'ffffffff-0002-0002-0002-000000000001',
  'cause',
  '50000000-0000-0000-0000-000000000002',
  'postgresql replication lag incident root cause',
  '{"note":"long analytical query blocked WAL replay"}'::jsonb,
  '2026-02-01T12:00:00Z',
  NULL,
  0.95,
  'deterministic',
  '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'device:server-b',
  '{"source":"synthetic-event-timeline-smoke"}'::jsonb,
  '00000000-0000-0000-0000-000000000002'
),
(
  'ef000000-0002-0002-0002-000000000002',
  'default',
  repeat('d', 64),
  'eeeeeeee-0002-0002-0002-000000000002',
  'ffffffff-0002-0002-0002-000000000002',
  'remediation',
  '50000000-0000-0000-0000-000000000002',
  'max_standby_streaming_delay raised to fix WAL replay',
  '{"note":"raised standby delay to 300s"}'::jsonb,
  '2026-02-01T14:00:00Z',
  'replica caught up',
  0.90,
  'human_curated',
  '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'device:server-b',
  '{"source":"synthetic-event-timeline-smoke"}'::jsonb,
  '00000000-0000-0000-0000-000000000002'
),
(
  'ef000000-0003-0003-0003-000000000001',
  'default',
  repeat('e', 64),
  'eeeeeeee-0003-0003-0003-000000000003',
  'ffffffff-0003-0003-0003-000000000001',
  'cause',
  '50000000-0000-0000-0000-000000000003',
  'certificate expired causing 502 errors on server-a',
  '{"note":"expired certificate caused nginx 502"}'::jsonb,
  '2026-02-15T09:00:00Z',
  NULL,
  0.95,
  'deterministic',
  '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'device:server-a',
  '{"source":"synthetic-event-timeline-smoke"}'::jsonb,
  '00000000-0000-0000-0000-000000000003'
),
(
  'ef000000-0003-0003-0003-000000000002',
  'default',
  repeat('f', 64),
  'eeeeeeee-0003-0003-0003-000000000003',
  'ffffffff-0003-0003-0003-000000000002',
  'remediation',
  '50000000-0000-0000-0000-000000000003',
  'certbot auto-renewal automated certificate renewal after nginx outage',
  '{"note":"enabled certbot timer"}'::jsonb,
  '2026-02-15T10:30:00Z',
  'nginx service restored',
  0.90,
  'human_curated',
  '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'device:server-a',
  '{"source":"synthetic-event-timeline-smoke"}'::jsonb,
  '00000000-0000-0000-0000-000000000003'
)
ON CONFLICT (tenant, frame_fingerprint) DO UPDATE SET
  episode_id = EXCLUDED.episode_id,
  source_fact_id = EXCLUDED.source_fact_id,
  event_type = EXCLUDED.event_type,
  actor_entity_id = EXCLUDED.actor_entity_id,
  action = EXCLUDED.action,
  object_value = EXCLUDED.object_value,
  time_start = EXCLUDED.time_start,
  outcome = EXCLUDED.outcome,
  confidence = EXCLUDED.confidence,
  assertion_class = EXCLUDED.assertion_class,
  evidence_segment_id = EXCLUDED.evidence_segment_id,
  scope_path = EXCLUDED.scope_path,
  frame_json = EXCLUDED.frame_json,
  created_run_id = EXCLUDED.created_run_id,
  updated_at = now();

COMMIT;
