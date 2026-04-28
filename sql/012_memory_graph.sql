-- BrainCore Preserve Schema: typed memory graph + revision audit tables.
--
-- This migration intentionally does not add enum values. Edge and revision
-- vocabularies are constrained with CHECK clauses so future vocabulary changes
-- can be shipped independently of PostgreSQL enum lifecycle constraints.

CREATE TABLE IF NOT EXISTS preserve.memory_edge (
    edge_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant               TEXT                         NOT NULL,
    source_type          TEXT                         NOT NULL,
    source_id            UUID                         NOT NULL,
    target_type          TEXT                         NOT NULL,
    target_id            UUID                         NOT NULL,
    edge_type            TEXT                         NOT NULL,
    edge_fingerprint     TEXT                         NOT NULL,
    confidence           NUMERIC(3,2)                 NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    assertion_class      preserve.assertion_class     NOT NULL,
    evidence_segment_id  UUID                         REFERENCES preserve.segment(segment_id),
    created_run_id       UUID                         REFERENCES preserve.extraction_run(run_id),
    valid_from           TIMESTAMPTZ,
    valid_to             TIMESTAMPTZ,
    scope_path           TEXT,
    created_at           TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT chk_memory_edge_source_type CHECK (
        source_type IN ('fact','memory','episode','entity','event')
    ),
    CONSTRAINT chk_memory_edge_target_type CHECK (
        target_type IN ('fact','memory','episode','entity','event')
    ),
    CONSTRAINT chk_memory_edge_type CHECK (
        edge_type IN (
            'supports',
            'contradicts',
            'caused_by',
            'precedes',
            'follows',
            'fixes',
            'regresses',
            'supersedes',
            'duplicates',
            'mitigates',
            'depends_on',
            'similar_to',
            'explains',
            'discovered_during'
        )
    ),
    CONSTRAINT chk_memory_edge_not_self CHECK (
        source_type <> target_type OR source_id <> target_id
    ),
    CONSTRAINT uq_memory_edge_tenant_fingerprint UNIQUE (tenant, edge_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_memory_edge_source
    ON preserve.memory_edge (tenant, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_memory_edge_target
    ON preserve.memory_edge (tenant, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_memory_edge_type
    ON preserve.memory_edge (tenant, edge_type);
CREATE INDEX IF NOT EXISTS idx_memory_edge_assertion_class
    ON preserve.memory_edge (tenant, assertion_class);
CREATE INDEX IF NOT EXISTS idx_memory_edge_scope_path
    ON preserve.memory_edge (tenant, scope_path);
CREATE INDEX IF NOT EXISTS idx_memory_edge_validity_range
    ON preserve.memory_edge USING GiST (tstzrange(valid_from, valid_to));

CREATE TABLE IF NOT EXISTS preserve.memory_edge_evidence (
    edge_evidence_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    edge_id              UUID                         NOT NULL REFERENCES preserve.memory_edge(edge_id) ON DELETE CASCADE,
    fact_id              UUID                         REFERENCES preserve.fact(fact_id),
    episode_id           UUID                         REFERENCES preserve.episode(episode_id),
    segment_id           UUID                         REFERENCES preserve.segment(segment_id),
    notes                TEXT,
    weight               NUMERIC(3,2)                 NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
    created_at           TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT chk_memory_edge_evidence_has_support CHECK (
        fact_id IS NOT NULL OR episode_id IS NOT NULL OR segment_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_memory_edge_evidence_edge
    ON preserve.memory_edge_evidence (edge_id);
CREATE INDEX IF NOT EXISTS idx_memory_edge_evidence_fact
    ON preserve.memory_edge_evidence (fact_id);
CREATE INDEX IF NOT EXISTS idx_memory_edge_evidence_episode
    ON preserve.memory_edge_evidence (episode_id);
CREATE INDEX IF NOT EXISTS idx_memory_edge_evidence_segment
    ON preserve.memory_edge_evidence (segment_id);

CREATE TABLE IF NOT EXISTS preserve.memory_revision (
    revision_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id            UUID                         NOT NULL REFERENCES preserve.memory(memory_id) ON DELETE CASCADE,
    tenant               TEXT                         NOT NULL,
    revision_type        TEXT                         NOT NULL,
    old_narrative        TEXT,
    new_narrative        TEXT,
    change_reason        TEXT                         NOT NULL,
    model_name           TEXT,
    prompt_version       TEXT,
    created_run_id       UUID                         REFERENCES preserve.extraction_run(run_id),
    created_at           TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT chk_memory_revision_type CHECK (
        revision_type IN ('created','enriched','merged','split','demoted','retired')
    )
);

CREATE INDEX IF NOT EXISTS idx_memory_revision_memory
    ON preserve.memory_revision (tenant, memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_revision_type
    ON preserve.memory_revision (tenant, revision_type);

CREATE TABLE IF NOT EXISTS preserve.memory_revision_support (
    revision_support_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    revision_id          UUID                         NOT NULL REFERENCES preserve.memory_revision(revision_id) ON DELETE CASCADE,
    fact_id              UUID                         REFERENCES preserve.fact(fact_id),
    episode_id           UUID                         REFERENCES preserve.episode(episode_id),
    edge_id              UUID                         REFERENCES preserve.memory_edge(edge_id),
    notes                TEXT,
    created_at           TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT chk_memory_revision_support_has_item CHECK (
        fact_id IS NOT NULL OR episode_id IS NOT NULL OR edge_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_memory_revision_support_revision
    ON preserve.memory_revision_support (revision_id);
CREATE INDEX IF NOT EXISTS idx_memory_revision_support_fact
    ON preserve.memory_revision_support (fact_id);
CREATE INDEX IF NOT EXISTS idx_memory_revision_support_episode
    ON preserve.memory_revision_support (episode_id);
CREATE INDEX IF NOT EXISTS idx_memory_revision_support_edge
    ON preserve.memory_revision_support (edge_id);
