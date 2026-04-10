-- =============================================================================
-- BrainCore Preserve Schema  —  009_schema_alignment.sql
-- Aligns the persisted schema with the fields the shipped runtime already uses.
-- Idempotent by design: every statement is safe on repeated `braincore migrate`.
-- =============================================================================

SET search_path TO preserve, public;

ALTER TABLE preserve.artifact
    ADD COLUMN IF NOT EXISTS project_entity_id UUID;

ALTER TABLE preserve.segment
    ADD COLUMN IF NOT EXISTS project_entity_id UUID;

ALTER TABLE preserve.episode
    ADD COLUMN IF NOT EXISTS project_entity_id UUID REFERENCES preserve.entity(entity_id);

ALTER TABLE preserve.fact
    ADD COLUMN IF NOT EXISTS project_entity_id UUID REFERENCES preserve.entity(entity_id);

ALTER TABLE preserve.fact
    ADD COLUMN IF NOT EXISTS importance_score INTEGER NOT NULL DEFAULT 0;

ALTER TABLE preserve.memory
    ADD COLUMN IF NOT EXISTS project_entity_id UUID REFERENCES preserve.entity(entity_id);

ALTER TABLE preserve.memory
    ADD COLUMN IF NOT EXISTS last_supported_at TIMESTAMPTZ;

UPDATE preserve.memory
SET last_supported_at = COALESCE(last_supported_at, updated_at, created_at)
WHERE last_supported_at IS NULL;

DO $$ BEGIN
  ALTER TABLE preserve.artifact
    ADD CONSTRAINT fk_artifact_project_entity
    FOREIGN KEY (project_entity_id) REFERENCES preserve.entity(entity_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE preserve.segment
    ADD CONSTRAINT fk_segment_project_entity
    FOREIGN KEY (project_entity_id) REFERENCES preserve.entity(entity_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_artifact_project_entity
    ON preserve.artifact (project_entity_id);
CREATE INDEX IF NOT EXISTS idx_segment_project_entity
    ON preserve.segment (project_entity_id);
CREATE INDEX IF NOT EXISTS idx_episode_project_entity
    ON preserve.episode (project_entity_id);
CREATE INDEX IF NOT EXISTS idx_fact_project_entity
    ON preserve.fact (project_entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_project_entity
    ON preserve.memory (project_entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_last_supported_at
    ON preserve.memory (last_supported_at);

CREATE INDEX IF NOT EXISTS idx_fact_tenant_fingerprint
    ON preserve.fact (tenant, canonical_fingerprint);
CREATE INDEX IF NOT EXISTS idx_memory_tenant_fingerprint
    ON preserve.memory (tenant, fingerprint);
