-- examples/seed-projects.sql
-- Generic example: seed projects and service mappings

BEGIN;

INSERT INTO preserve.entity (entity_type, canonical_name, aliases, attrs)
VALUES
  ('project', 'web-platform',   '[]'::jsonb, '{"description": "Main web platform"}'::jsonb),
  ('project', 'data-pipeline',  '[]'::jsonb, '{"description": "Data processing pipeline"}'::jsonb),
  ('project', 'infrastructure', '[]'::jsonb, '{"description": "Core infrastructure"}'::jsonb)
ON CONFLICT (entity_type, canonical_name) DO NOTHING;

INSERT INTO preserve.project_service_map (project_entity_id, service_name)
SELECT e.entity_id, svc.name
FROM preserve.entity e,
LATERAL (VALUES
  ('web-platform', 'nginx'),
  ('web-platform', 'api'),
  ('web-platform', 'frontend'),
  ('data-pipeline', 'worker'),
  ('data-pipeline', 'scheduler'),
  ('infrastructure', 'postgresql'),
  ('infrastructure', 'docker'),
  ('infrastructure', 'grafana')
) AS svc(project, name)
WHERE e.entity_type = 'project' AND e.canonical_name = svc.project
ON CONFLICT (project_entity_id, service_name) DO NOTHING;

COMMIT;
