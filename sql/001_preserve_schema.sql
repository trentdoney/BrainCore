-- =============================================================================
-- BrainCore Preserve Schema  —  001_preserve_schema.sql
-- Full schema for the knowledge-extraction pipeline.
-- Idempotent: safe to re-run (IF NOT EXISTS / DO $$ EXCEPTION patterns).
-- Preserves existing archive_object table.
-- =============================================================================

SET search_path TO preserve, public;

-- ---------------------------------------------------------------------------
-- 0. pgvector (already enabled, but guard anyway)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- 1. ENUM TYPES (idempotent via EXCEPTION handler)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE preserve.source_type AS ENUM (
    'opsvault_incident','claude_session','claude_plan','device_log',
    'config_diff','project_doc','pai_memory'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.preservation_state AS ENUM (
    'discovered','archived','extracted','published','blocked','failed','pending_escalation'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.extraction_status AS ENUM (
    'pending','running','success','partial','failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.entity_type AS ENUM (
    'device','service','project','file','config_item','pattern_scope','incident','session'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.fact_kind AS ENUM (
    'state','cause','impact','decision','remediation','lesson','constraint','config_change','event'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.fact_status AS ENUM (
    'active','superseded','contradicted','uncertain'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.assertion_class AS ENUM (
    'deterministic','human_curated','corroborated_llm','single_source_llm','retired'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.extraction_method AS ENUM (
    'rule','llm','human_curated'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.memory_type AS ENUM (
    'entity_summary','pattern','playbook','heuristic'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.lifecycle_state AS ENUM (
    'draft','published','retired'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE preserve.review_status AS ENUM (
    'pending','approved','rejected','deferred'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. TABLES
-- ---------------------------------------------------------------------------

-- 2.1 artifact  (master artifact tracker)
CREATE TABLE IF NOT EXISTS preserve.artifact (
    artifact_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type          preserve.source_type        NOT NULL,
    source_key           TEXT                         NOT NULL UNIQUE,
    original_path        TEXT                         NOT NULL,
    host                 TEXT,
    ttl_at               TIMESTAMPTZ,
    sha256               TEXT                         NOT NULL,
    size_bytes           BIGINT                       NOT NULL,
    value_score          NUMERIC(5,2)                 DEFAULT 0,
    preservation_state   preserve.preservation_state  NOT NULL DEFAULT 'discovered',
    can_evict_hot        BOOLEAN                      NOT NULL DEFAULT FALSE,
    can_query_raw        BOOLEAN                      NOT NULL DEFAULT FALSE,
    can_promote_memory   BOOLEAN                      NOT NULL DEFAULT FALSE,
    scope_path           TEXT,
    meta                 JSONB                        DEFAULT '{}',
    opsvault_file_id     UUID,
    opsvault_incident_id UUID,
    discovered_at        TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ                  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifact_source_type
    ON preserve.artifact (source_type);
CREATE INDEX IF NOT EXISTS idx_artifact_preservation_state
    ON preserve.artifact (preservation_state);
CREATE INDEX IF NOT EXISTS idx_artifact_host
    ON preserve.artifact (host);
CREATE INDEX IF NOT EXISTS idx_artifact_can_evict_hot
    ON preserve.artifact (can_evict_hot) WHERE can_evict_hot = FALSE;
CREATE INDEX IF NOT EXISTS idx_artifact_scope_path
    ON preserve.artifact (scope_path);


-- 2.2 segment  (evidence spans)
CREATE TABLE IF NOT EXISTS preserve.segment (
    segment_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id         UUID          NOT NULL REFERENCES preserve.artifact(artifact_id),
    ordinal             INTEGER       NOT NULL,
    line_start          INTEGER,
    line_end            INTEGER,
    ts_start            TIMESTAMPTZ,
    ts_end              TIMESTAMPTZ,
    section_label       TEXT,
    content             TEXT          NOT NULL,
    scope_path          TEXT,
    source_sha256       TEXT          NOT NULL,
    source_relpath      TEXT,
    archive_member_path TEXT,
    excerpt_hash        TEXT,
    byte_start          BIGINT,
    byte_end            BIGINT,
    embedding           vector(384),
    fts                 TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    created_at          TIMESTAMPTZ   DEFAULT now(),
    UNIQUE (artifact_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_segment_artifact_id
    ON preserve.segment (artifact_id);
CREATE INDEX IF NOT EXISTS idx_segment_ts_range
    ON preserve.segment (ts_start, ts_end);
CREATE INDEX IF NOT EXISTS idx_segment_fts
    ON preserve.segment USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_segment_embedding
    ON preserve.segment USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_segment_section_label
    ON preserve.segment (section_label);
CREATE INDEX IF NOT EXISTS idx_segment_scope_path
    ON preserve.segment (scope_path);


-- 2.3 extraction_run
CREATE TABLE IF NOT EXISTS preserve.extraction_run (
    run_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id         UUID          REFERENCES preserve.artifact(artifact_id),
    pipeline_version    TEXT,
    model_name          TEXT,
    prompt_version      TEXT,
    schema_version      INTEGER       DEFAULT 1,
    idempotency_key     TEXT          UNIQUE,
    status              preserve.extraction_status DEFAULT 'pending',
    raw_output          JSONB,
    validation_errors   JSONB,
    duration_ms         INTEGER,
    started_at          TIMESTAMPTZ   DEFAULT now(),
    finished_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_extraction_run_artifact_id
    ON preserve.extraction_run (artifact_id);
CREATE INDEX IF NOT EXISTS idx_extraction_run_status
    ON preserve.extraction_run (status);
CREATE INDEX IF NOT EXISTS idx_extraction_run_pipeline_model
    ON preserve.extraction_run (pipeline_version, model_name);


-- 2.4 entity
CREATE TABLE IF NOT EXISTS preserve.entity (
    entity_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type         preserve.entity_type NOT NULL,
    canonical_name      TEXT          NOT NULL,
    aliases             JSONB         DEFAULT '[]',
    attrs               JSONB         DEFAULT '{}',
    first_seen_at       TIMESTAMPTZ   DEFAULT now(),
    last_seen_at        TIMESTAMPTZ   DEFAULT now(),
    embedding           vector(384),
    UNIQUE (entity_type, canonical_name)
);

CREATE INDEX IF NOT EXISTS idx_entity_type
    ON preserve.entity (entity_type);
CREATE INDEX IF NOT EXISTS idx_entity_name
    ON preserve.entity (canonical_name);
CREATE INDEX IF NOT EXISTS idx_entity_embedding
    ON preserve.entity USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);


-- 2.5 episode
CREATE TABLE IF NOT EXISTS preserve.episode (
    episode_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_type          TEXT,
    title                 TEXT,
    start_at              TIMESTAMPTZ,
    end_at                TIMESTAMPTZ,
    severity              TEXT,
    outcome               TEXT,
    summary               TEXT,
    primary_artifact_id   UUID          REFERENCES preserve.artifact(artifact_id),
    scope_path            TEXT,
    embedding             vector(384),
    fts                   TSVECTOR GENERATED ALWAYS AS (
                            to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,''))
                          ) STORED,
    created_at            TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episode_type_start
    ON preserve.episode (episode_type, start_at);
CREATE INDEX IF NOT EXISTS idx_episode_artifact
    ON preserve.episode (primary_artifact_id);
CREATE INDEX IF NOT EXISTS idx_episode_fts
    ON preserve.episode USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_episode_embedding
    ON preserve.episode USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_episode_scope_path
    ON preserve.episode (scope_path);


-- 2.6 event
CREATE TABLE IF NOT EXISTS preserve.event (
    event_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_id          UUID          REFERENCES preserve.episode(episode_id),
    event_type          TEXT,
    occurred_at         TIMESTAMPTZ,
    description         TEXT,
    entity_id           UUID          REFERENCES preserve.entity(entity_id),
    segment_id          UUID          REFERENCES preserve.segment(segment_id),
    meta                JSONB         DEFAULT '{}',
    created_run_id      UUID          REFERENCES preserve.extraction_run(run_id),
    created_at          TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_episode
    ON preserve.event (episode_id);
CREATE INDEX IF NOT EXISTS idx_event_type_occurred
    ON preserve.event (event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_event_entity
    ON preserve.event (entity_id);


-- 2.7 fact  (central truth table)
CREATE TABLE IF NOT EXISTS preserve.fact (
    fact_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_entity_id       UUID          NOT NULL REFERENCES preserve.entity(entity_id),
    predicate               TEXT          NOT NULL,
    object_entity_id        UUID          REFERENCES preserve.entity(entity_id),
    object_value            JSONB,
    fact_kind               preserve.fact_kind          NOT NULL,
    assertion_class         preserve.assertion_class    NOT NULL DEFAULT 'single_source_llm',
    confidence              NUMERIC(3,2)  NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    valid_from              TIMESTAMPTZ,
    valid_to                TIMESTAMPTZ,
    first_seen_at           TIMESTAMPTZ   DEFAULT now(),
    last_seen_at            TIMESTAMPTZ   DEFAULT now(),
    current_status          preserve.fact_status        DEFAULT 'active',
    canonical_fingerprint   TEXT          NOT NULL,
    episode_id              UUID          REFERENCES preserve.episode(episode_id),
    created_run_id          UUID          NOT NULL REFERENCES preserve.extraction_run(run_id),
    scope_path              TEXT,
    embedding               vector(384),
    fts                     TSVECTOR GENERATED ALWAYS AS (
                              to_tsvector('english', predicate || ' ' || coalesce(object_value::text, ''))
                            ) STORED,
    created_at              TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fact_subject_pred_valid
    ON preserve.fact (subject_entity_id, predicate, valid_from);
CREATE INDEX IF NOT EXISTS idx_fact_kind
    ON preserve.fact (fact_kind);
CREATE INDEX IF NOT EXISTS idx_fact_status
    ON preserve.fact (current_status);
CREATE INDEX IF NOT EXISTS idx_fact_validity_range
    ON preserve.fact USING GiST (tstzrange(valid_from, valid_to));
CREATE INDEX IF NOT EXISTS idx_fact_fingerprint
    ON preserve.fact (canonical_fingerprint);
CREATE INDEX IF NOT EXISTS idx_fact_episode
    ON preserve.fact (episode_id);
CREATE INDEX IF NOT EXISTS idx_fact_fts
    ON preserve.fact USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_fact_embedding
    ON preserve.fact USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_fact_assertion_class
    ON preserve.fact (assertion_class);
CREATE INDEX IF NOT EXISTS idx_fact_scope_path
    ON preserve.fact (scope_path);


-- 2.8 fact_evidence
CREATE TABLE IF NOT EXISTS preserve.fact_evidence (
    fact_evidence_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fact_id             UUID          REFERENCES preserve.fact(fact_id),
    segment_id          UUID          REFERENCES preserve.segment(segment_id),
    excerpt             TEXT          NOT NULL,
    extraction_method   preserve.extraction_method,
    weight              NUMERIC(3,2)  DEFAULT 1.0,
    source_sha256       TEXT          NOT NULL,
    source_relpath      TEXT,
    line_start          INTEGER,
    line_end            INTEGER,
    excerpt_hash        TEXT          NOT NULL,
    created_at          TIMESTAMPTZ   DEFAULT now(),
    UNIQUE (fact_id, segment_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_evidence_fact
    ON preserve.fact_evidence (fact_id);
CREATE INDEX IF NOT EXISTS idx_fact_evidence_segment
    ON preserve.fact_evidence (segment_id);


-- 2.9 memory  (derived knowledge)
CREATE TABLE IF NOT EXISTS preserve.memory (
    memory_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_type           preserve.memory_type,
    scope_entity_id       UUID          REFERENCES preserve.entity(entity_id),
    fingerprint           TEXT          UNIQUE,
    title                 TEXT,
    narrative             TEXT,
    support_count         INTEGER       DEFAULT 0,
    contradiction_count   INTEGER       DEFAULT 0,
    confidence            NUMERIC(3,2)  CHECK (confidence >= 0 AND confidence <= 1),
    valid_from            TIMESTAMPTZ,
    valid_to              TIMESTAMPTZ,
    lifecycle_state       preserve.lifecycle_state     DEFAULT 'draft',
    pipeline_version      TEXT,
    model_name            TEXT,
    prompt_version        TEXT,
    scope_path            TEXT,
    embedding             vector(384),
    fts                   TSVECTOR GENERATED ALWAYS AS (
                            to_tsvector('english', title || ' ' || narrative)
                          ) STORED,
    created_at            TIMESTAMPTZ   DEFAULT now(),
    updated_at            TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_type
    ON preserve.memory (memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_scope_entity
    ON preserve.memory (scope_entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_lifecycle
    ON preserve.memory (lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_memory_validity_range
    ON preserve.memory USING GiST (tstzrange(valid_from, valid_to));
CREATE INDEX IF NOT EXISTS idx_memory_fts
    ON preserve.memory USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_memory_embedding
    ON preserve.memory USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_memory_scope_path
    ON preserve.memory (scope_path);


-- 2.10 memory_support
CREATE TABLE IF NOT EXISTS preserve.memory_support (
    support_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id           UUID          REFERENCES preserve.memory(memory_id),
    fact_id             UUID          REFERENCES preserve.fact(fact_id),
    episode_id          UUID          REFERENCES preserve.episode(episode_id),
    support_type        TEXT          CHECK (support_type IN ('supporting','counter','neutral')),
    notes               TEXT,
    created_at          TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_support_memory
    ON preserve.memory_support (memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_support_fact
    ON preserve.memory_support (fact_id);
CREATE INDEX IF NOT EXISTS idx_memory_support_episode
    ON preserve.memory_support (episode_id);


-- 2.11 review_queue
CREATE TABLE IF NOT EXISTS preserve.review_queue (
    review_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type         TEXT          NOT NULL,
    target_id           UUID          NOT NULL,
    reason              TEXT          NOT NULL,
    status              preserve.review_status        DEFAULT 'pending',
    reviewer_notes      TEXT,
    created_at          TIMESTAMPTZ   DEFAULT now(),
    resolved_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_review_queue_status
    ON preserve.review_queue (status);
CREATE INDEX IF NOT EXISTS idx_review_queue_target
    ON preserve.review_queue (target_type, target_id);


-- ---------------------------------------------------------------------------
-- 3. TRIGGERS  —  auto-update updated_at on artifact and memory
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION preserve.trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- artifact trigger
DROP TRIGGER IF EXISTS trg_artifact_updated_at ON preserve.artifact;
CREATE TRIGGER trg_artifact_updated_at
    BEFORE UPDATE ON preserve.artifact
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();

-- memory trigger
DROP TRIGGER IF EXISTS trg_memory_updated_at ON preserve.memory;
CREATE TRIGGER trg_memory_updated_at
    BEFORE UPDATE ON preserve.memory
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();


-- ---------------------------------------------------------------------------
-- Done.
-- ---------------------------------------------------------------------------
