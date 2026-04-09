-- 004_seed_projects.example.sql
-- Example: Seed project entities and service mappings for BrainCore project scoping.
-- Copy this file and customize for your infrastructure.

BEGIN;

-- Insert project entities (ON CONFLICT skip if already seeded)
INSERT INTO preserve.entity (entity_type, canonical_name, aliases, attrs)
VALUES
  ('project', 'web-app',         '[]'::jsonb, '{"description": "Main web application"}'::jsonb),
  ('project', 'api-service',     '[]'::jsonb, '{"description": "Backend API service"}'::jsonb),
  ('project', 'data-pipeline',   '[]'::jsonb, '{"description": "Data processing pipeline"}'::jsonb),
  ('project', 'monitoring',      '[]'::jsonb, '{"description": "Monitoring and alerting infrastructure"}'::jsonb),
  ('project', 'system-infra',    '[]'::jsonb, '{"description": "System infrastructure: PostgreSQL, Docker, etc."}'::jsonb)
ON CONFLICT (entity_type, canonical_name) DO NOTHING;

-- Map services to projects
INSERT INTO preserve.project_service_map (project_entity_id, service_name)
SELECT e.entity_id, svc.name
FROM preserve.entity e,
LATERAL (VALUES
  -- web-app
  ('web-app', 'nginx'),
  ('web-app', 'frontend'),
  -- api-service
  ('api-service', 'api'),
  ('api-service', 'worker'),
  -- data-pipeline
  ('data-pipeline', 'pipeline'),
  ('data-pipeline', 'scheduler'),
  -- monitoring
  ('monitoring', 'grafana'),
  ('monitoring', 'prometheus'),
  -- system-infra
  ('system-infra', 'postgresql'),
  ('system-infra', 'docker'),
  ('system-infra', 'nginx'),
  ('system-infra', 'ssh')
) AS svc(project, name)
WHERE e.entity_type = 'project' AND e.canonical_name = svc.project
ON CONFLICT (project_entity_id, service_name) DO NOTHING;

-- Verify
SELECT e.canonical_name AS project, count(psm.service_name) AS services
FROM preserve.entity e
JOIN preserve.project_service_map psm ON psm.project_entity_id = e.entity_id
WHERE e.entity_type = 'project'
GROUP BY e.canonical_name
ORDER BY e.canonical_name;

COMMIT;
