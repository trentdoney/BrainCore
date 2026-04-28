-- 005_priority_tenant.sql
-- Priority flags (1 highest, 10 lowest, default 5) + tenant scoping

-- Priority columns
ALTER TABLE preserve.artifact ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5;
ALTER TABLE preserve.fact ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5;
ALTER TABLE preserve.memory ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 5;

-- Priority indexes (partial — only high-priority rows)
CREATE INDEX IF NOT EXISTS idx_artifact_priority ON preserve.artifact(priority) WHERE priority <= 3;
CREATE INDEX IF NOT EXISTS idx_fact_priority ON preserve.fact(priority) WHERE priority <= 3;
CREATE INDEX IF NOT EXISTS idx_memory_priority ON preserve.memory(priority) WHERE priority <= 3;

-- Priority constraints
DO $$ BEGIN
  ALTER TABLE preserve.artifact ADD CONSTRAINT chk_artifact_priority CHECK (priority BETWEEN 1 AND 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE preserve.fact ADD CONSTRAINT chk_fact_priority CHECK (priority BETWEEN 1 AND 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE preserve.memory ADD CONSTRAINT chk_memory_priority CHECK (priority BETWEEN 1 AND 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tenant columns
ALTER TABLE preserve.entity ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default';
ALTER TABLE preserve.artifact ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default';
ALTER TABLE preserve.fact ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default';
ALTER TABLE preserve.segment ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default';
ALTER TABLE preserve.memory ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default';
ALTER TABLE preserve.episode ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default';

-- Tenant indexes
CREATE INDEX IF NOT EXISTS idx_artifact_tenant ON preserve.artifact(tenant);
CREATE INDEX IF NOT EXISTS idx_fact_tenant ON preserve.fact(tenant);
CREATE INDEX IF NOT EXISTS idx_memory_tenant ON preserve.memory(tenant);
CREATE INDEX IF NOT EXISTS idx_segment_tenant ON preserve.segment(tenant);
CREATE INDEX IF NOT EXISTS idx_episode_tenant ON preserve.episode(tenant);
CREATE INDEX IF NOT EXISTS idx_entity_tenant ON preserve.entity(tenant);
