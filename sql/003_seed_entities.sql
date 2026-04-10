-- =============================================================================
-- BrainCore Preserve  —  003_seed_entities.sql
-- Seed device entities for your infrastructure fleet.
-- Idempotent via ON CONFLICT DO NOTHING.
-- Customize these for your own environment.
-- =============================================================================

INSERT INTO preserve.entity (tenant, entity_type, canonical_name, aliases, attrs)
VALUES
    ('default', 'device', 'server-a',     '["server-a"]',
     '{"role": "GPU server + PostgreSQL", "os": "Linux"}'),
    ('default', 'device', 'server-b',     '["server-b"]',
     '{"role": "Application server", "os": "Linux"}'),
    ('default', 'device', 'workstation',  '["workstation"]',
     '{"role": "Developer workstation", "os": "Linux"}')
ON CONFLICT DO NOTHING;
