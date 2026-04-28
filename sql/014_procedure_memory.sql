-- BrainCore Preserve Schema: evidence-grounded procedure memory.
--
-- Procedures capture ordered operational steps without replacing the source
-- facts, segments, episodes, or playbooks that justify them. Every procedure
-- and step is tenant-scoped and must retain at least one evidence anchor.

CREATE TABLE IF NOT EXISTS preserve.procedure (
    procedure_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                  TEXT                         NOT NULL,
    procedure_fingerprint   TEXT                         NOT NULL,
    title                   TEXT                         NOT NULL,
    summary                 TEXT,
    source_fact_id          UUID                         REFERENCES preserve.fact(fact_id) ON DELETE SET NULL,
    source_memory_id        UUID                         REFERENCES preserve.memory(memory_id) ON DELETE SET NULL,
    source_episode_id       UUID                         REFERENCES preserve.episode(episode_id) ON DELETE SET NULL,
    scope_entity_id         UUID                         REFERENCES preserve.entity(entity_id),
    project_entity_id       UUID                         REFERENCES preserve.entity(entity_id),
    evidence_segment_id     UUID                         REFERENCES preserve.segment(segment_id),
    assertion_class         preserve.assertion_class     NOT NULL,
    confidence              NUMERIC(3,2)                 NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    lifecycle_state         preserve.lifecycle_state     NOT NULL DEFAULT 'draft',
    scope_path              TEXT,
    procedure_json          JSONB                        NOT NULL DEFAULT '{}',
    created_run_id          UUID                         REFERENCES preserve.extraction_run(run_id),
    created_at              TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    fts                     TSVECTOR GENERATED ALWAYS AS (
                                to_tsvector('english', title || ' ' || coalesce(summary, ''))
                            ) STORED,
    CONSTRAINT uq_procedure_tenant_fingerprint UNIQUE (tenant, procedure_fingerprint),
    CONSTRAINT uq_procedure_tenant_id UNIQUE (tenant, procedure_id),
    CONSTRAINT chk_procedure_has_evidence CHECK (
        source_fact_id IS NOT NULL
        OR source_memory_id IS NOT NULL
        OR source_episode_id IS NOT NULL
        OR evidence_segment_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_procedure_source_fact
    ON preserve.procedure (tenant, source_fact_id);
CREATE INDEX IF NOT EXISTS idx_procedure_source_memory
    ON preserve.procedure (tenant, source_memory_id);
CREATE INDEX IF NOT EXISTS idx_procedure_source_episode
    ON preserve.procedure (tenant, source_episode_id);
CREATE INDEX IF NOT EXISTS idx_procedure_scope_entity
    ON preserve.procedure (tenant, scope_entity_id);
CREATE INDEX IF NOT EXISTS idx_procedure_project_entity
    ON preserve.procedure (tenant, project_entity_id);
CREATE INDEX IF NOT EXISTS idx_procedure_scope_path
    ON preserve.procedure (tenant, scope_path);
CREATE INDEX IF NOT EXISTS idx_procedure_lifecycle
    ON preserve.procedure (tenant, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_procedure_fts
    ON preserve.procedure USING GIN (fts);

CREATE TABLE IF NOT EXISTS preserve.procedure_step (
    procedure_step_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    procedure_id            UUID                         NOT NULL,
    tenant                  TEXT                         NOT NULL,
    step_index              INTEGER                      NOT NULL CHECK (step_index > 0),
    action                  TEXT                         NOT NULL,
    expected_result         TEXT,
    source_fact_id          UUID                         REFERENCES preserve.fact(fact_id) ON DELETE SET NULL,
    evidence_segment_id     UUID                         REFERENCES preserve.segment(segment_id),
    assertion_class         preserve.assertion_class     NOT NULL,
    confidence              NUMERIC(3,2)                 NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    scope_path              TEXT,
    step_json               JSONB                        NOT NULL DEFAULT '{}',
    created_run_id          UUID                         REFERENCES preserve.extraction_run(run_id),
    created_at              TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT fk_procedure_step_tenant_procedure FOREIGN KEY (tenant, procedure_id)
        REFERENCES preserve.procedure(tenant, procedure_id) ON DELETE CASCADE,
    CONSTRAINT uq_procedure_step_order UNIQUE (procedure_id, step_index),
    CONSTRAINT chk_procedure_step_has_evidence CHECK (
        source_fact_id IS NOT NULL OR evidence_segment_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_procedure_step_procedure
    ON preserve.procedure_step (tenant, procedure_id, step_index);
CREATE INDEX IF NOT EXISTS idx_procedure_step_source_fact
    ON preserve.procedure_step (tenant, source_fact_id);
CREATE INDEX IF NOT EXISTS idx_procedure_step_evidence
    ON preserve.procedure_step (evidence_segment_id);
CREATE INDEX IF NOT EXISTS idx_procedure_step_scope_path
    ON preserve.procedure_step (tenant, scope_path);

DROP TRIGGER IF EXISTS trg_procedure_updated_at ON preserve.procedure;
CREATE TRIGGER trg_procedure_updated_at
    BEFORE UPDATE ON preserve.procedure
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();
