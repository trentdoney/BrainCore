-- =============================================================================
-- BrainCore Preserve Schema - 022_memory_governance.sql
-- Additive memory governance layer for prompt recall, feedback, compaction, and audit workflows.
--
-- Compatibility rules:
-- - Do not replace preserve.memory.lifecycle_state.
-- - Do not rename draft/published/retired.
-- - Governance status is a separate prompt-safety and operator-review layer.
-- =============================================================================

SET search_path TO preserve, public;

DO $$ BEGIN
  CREATE TYPE preserve.memory_namespace AS ENUM (
    'working','episodic','semantic','procedural','policy'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.memory_governance_status AS ENUM (
    'candidate','archived','active','review_required','validated',
    'disputed','quarantined','suppressed','retired'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.memory_source_class AS ENUM (
    'observed','user_stated','system_inferred','summary_derived',
    'replay_derived','imported_knowledge','corrected_by_user'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.memory_trust_class AS ENUM (
    'deterministic','human_curated','corroborated_llm','single_source_llm','retired_superseded'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.memory_outbox_status AS ENUM (
    'pending','processing','completed','failed','dead_letter'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE preserve.memory
  ADD COLUMN IF NOT EXISTS namespace preserve.memory_namespace DEFAULT 'semantic' NOT NULL,
  ADD COLUMN IF NOT EXISTS governance_status preserve.memory_governance_status DEFAULT 'active' NOT NULL,
  ADD COLUMN IF NOT EXISTS source_class preserve.memory_source_class DEFAULT 'system_inferred' NOT NULL,
  ADD COLUMN IF NOT EXISTS trust_class preserve.memory_trust_class DEFAULT 'single_source_llm' NOT NULL,
  ADD COLUMN IF NOT EXISTS salience NUMERIC(4,3) DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS strength NUMERIC(4,3) DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS stability NUMERIC(4,3) DEFAULT 0.1,
  ADD COLUMN IF NOT EXISTS quality_score NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS summary_fidelity_score NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS token_count INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS schema_version INTEGER DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS config_version TEXT DEFAULT 'braincore-memory-governance-v1' NOT NULL,
  ADD COLUMN IF NOT EXISTS redaction_metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS governance_meta JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_reinforced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_decayed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_memory_namespace ON preserve.memory (namespace);
CREATE INDEX IF NOT EXISTS idx_memory_governance_status ON preserve.memory (governance_status);
CREATE INDEX IF NOT EXISTS idx_memory_source_class ON preserve.memory (source_class);
CREATE INDEX IF NOT EXISTS idx_memory_trust_class ON preserve.memory (trust_class);
CREATE INDEX IF NOT EXISTS idx_memory_quality_score ON preserve.memory (quality_score);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_tenant_memory_id ON preserve.memory (tenant, memory_id);

CREATE TABLE IF NOT EXISTS preserve.memory_lifecycle_outbox (
  outbox_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  source_service     TEXT NOT NULL,
  status             preserve.memory_outbox_status NOT NULL DEFAULT 'pending',
  tenant             TEXT NOT NULL DEFAULT 'default',
  project_entity_id  UUID REFERENCES preserve.entity(entity_id),
  episode_id         UUID REFERENCES preserve.episode(episode_id),
  trace_id           TEXT,
  span_id            TEXT,
  actor_type         TEXT,
  actor_id           TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 5,
  sensitivity_class  TEXT,
  redaction_status   TEXT,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_refs      JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_summary      TEXT,
  memory_id          UUID REFERENCES preserve.memory(memory_id),
  schema_version     INTEGER NOT NULL DEFAULT 1,
  config_version     TEXT NOT NULL DEFAULT 'braincore-memory-governance-v1'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_lifecycle_outbox_idempotency ON preserve.memory_lifecycle_outbox (tenant, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_lifecycle_outbox_event ON preserve.memory_lifecycle_outbox (tenant, event_id);
CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_outbox_status_next ON preserve.memory_lifecycle_outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_outbox_episode ON preserve.memory_lifecycle_outbox (episode_id);

CREATE TABLE IF NOT EXISTS preserve.memory_cue (
  cue_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id          UUID NOT NULL REFERENCES preserve.memory(memory_id) ON DELETE CASCADE,
  cue_text           TEXT NOT NULL,
  cue_hash           TEXT NOT NULL,
  cue_type           TEXT NOT NULL,
  extraction_method  TEXT NOT NULL,
  confidence         NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  evidence_ref       TEXT,
  usefulness_score   NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  last_used_at       TIMESTAMPTZ,
  last_successful_use_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (memory_id, cue_hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_cue_memory ON preserve.memory_cue (memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_cue_hash ON preserve.memory_cue (cue_hash);
CREATE INDEX IF NOT EXISTS idx_memory_cue_type ON preserve.memory_cue (cue_type);

CREATE TABLE IF NOT EXISTS preserve.memory_context_audit (
  audit_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant               TEXT NOT NULL DEFAULT 'default',
  query                TEXT,
  trigger              TEXT,
  retrieved_memory_ids UUID[] NOT NULL DEFAULT '{}',
  injected_memory_ids  UUID[] NOT NULL DEFAULT '{}',
  omitted              JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt_package       JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_tokens         INTEGER NOT NULL DEFAULT 0,
  max_tokens           INTEGER,
  relevance_reason     TEXT,
  actor                TEXT,
  route                TEXT,
  request_id           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_context_audit_tenant_created ON preserve.memory_context_audit (tenant, created_at DESC);

CREATE TABLE IF NOT EXISTS preserve.memory_feedback_event (
  feedback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   UUID REFERENCES preserve.memory(memory_id) ON DELETE SET NULL,
  tenant      TEXT NOT NULL DEFAULT 'default',
  signal      TEXT NOT NULL,
  outcome     TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_type  TEXT,
  actor_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_feedback_event_memory ON preserve.memory_feedback_event (memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_event_tenant_created ON preserve.memory_feedback_event (tenant, created_at DESC);

CREATE TABLE IF NOT EXISTS preserve.memory_quality_audit (
  quality_audit_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id              UUID REFERENCES preserve.memory(memory_id) ON DELETE SET NULL,
  tenant                 TEXT NOT NULL DEFAULT 'default',
  trigger_type           TEXT NOT NULL,
  previous_quality_score NUMERIC(4,3),
  new_quality_score      NUMERIC(4,3) NOT NULL,
  quality_factors        JSONB NOT NULL DEFAULT '{}'::jsonb,
  formula_version        TEXT NOT NULL DEFAULT 'braincore-memory-governance-v1',
  config_version         TEXT NOT NULL DEFAULT 'braincore-memory-governance-v1',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_quality_audit_memory ON preserve.memory_quality_audit (memory_id);

-- preserve.memory_edge is created by 012_memory_graph.sql.
-- Governance conflict detection writes memory-to-memory `contradicts` edges
-- into the existing typed graph schema.
