-- ============================================================================
-- seed_graph_smoke.sql — graph overlay for BrainCore retrieval smoke tests
-- ============================================================================
--
-- Applies deterministic memory_edge rows on top of benchmarks/seed_smoke.sql.
-- This file is intentionally separate so the existing baseline smoke benchmark
-- and its committed relevance numbers do not drift when graph retrieval is
-- tested.

BEGIN;

INSERT INTO preserve.memory (
  memory_id,
  memory_type,
  title,
  narrative,
  lifecycle_state,
  pipeline_version,
  model_name,
  prompt_version
) VALUES (
  'a0000000-0000-0000-0000-00000000016d',
  'playbook',
  'TLS timer operational playbook',
  'Use scheduled renewal checks and alerting for certificate lifecycle risk.',
  'published',
  'graph-smoke-seed',
  'synthetic',
  'v0'
)
ON CONFLICT DO NOTHING;

INSERT INTO preserve.memory_edge (
  tenant,
  source_type,
  source_id,
  target_type,
  target_id,
  edge_type,
  edge_fingerprint,
  confidence,
  assertion_class,
  evidence_segment_id,
  created_run_id,
  scope_path
) VALUES
(
  'default',
  'fact',
  'ffffffff-0001-0001-0001-000000000002',
  'memory',
  'a0000000-0000-0000-0000-00000000001d',
  'supports',
  repeat('1', 64),
  0.92,
  'deterministic',
  '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '00000000-0000-0000-0000-000000000001',
  'device:server-a'
),
(
  'default',
  'fact',
  'ffffffff-0002-0002-0002-000000000002',
  'memory',
  'a0000000-0000-0000-0000-00000000003d',
  'supports',
  repeat('2', 64),
  0.91,
  'deterministic',
  '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '00000000-0000-0000-0000-000000000002',
  'device:server-b'
),
(
  'default',
  'fact',
  'ffffffff-0003-0003-0003-000000000002',
  'memory',
  'a0000000-0000-0000-0000-00000000016d',
  'supports',
  repeat('3', 64),
  0.90,
  'deterministic',
  '33333333-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '00000000-0000-0000-0000-000000000003',
  'device:server-a'
)
ON CONFLICT (tenant, edge_fingerprint) DO UPDATE SET
  source_type = EXCLUDED.source_type,
  source_id = EXCLUDED.source_id,
  target_type = EXCLUDED.target_type,
  target_id = EXCLUDED.target_id,
  edge_type = EXCLUDED.edge_type,
  confidence = GREATEST(preserve.memory_edge.confidence, EXCLUDED.confidence),
  assertion_class = EXCLUDED.assertion_class,
  evidence_segment_id = EXCLUDED.evidence_segment_id,
  created_run_id = EXCLUDED.created_run_id,
  scope_path = EXCLUDED.scope_path,
  updated_at = now();

COMMIT;
