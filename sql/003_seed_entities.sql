-- =============================================================================
-- BrainCore Preserve  —  003_seed_entities.sql
-- Seed device entities for your infrastructure fleet.
-- Idempotent via ON CONFLICT DO NOTHING.
-- Customize these for your own environment.
-- =============================================================================

INSERT INTO preserve.entity (entity_type, canonical_name, aliases, attrs)
VALUES
    ('device', 'server-a',     '["server-a"]',
     '{"role": "GPU server + PostgreSQL", "os": "Linux"}'),
    ('device', 'server-b',     '["server-b"]',
     '{"role": "Application server", "os": "Linux"}'),
    ('device', 'workstation',  '["workstation"]',
     '{"role": "Developer workstation", "os": "Linux"}')
ON CONFLICT (entity_type, canonical_name) DO NOTHING;
