-- BrainCore Preserve Schema: reflection classes + memory health.
--
-- Reflection rows are derived artifacts, not facts. Each derived row carries a
-- primary evidence link, and expanded support can be attached through the
-- matching evidence table.

SET search_path TO preserve, public;

CREATE TABLE IF NOT EXISTS preserve.reflection_class (
    class_key          TEXT PRIMARY KEY,
    parent_class_key   TEXT REFERENCES preserve.reflection_class(class_key),
    display_name       TEXT        NOT NULL,
    target_kind        TEXT        NOT NULL CHECK (
        target_kind IN ('entity_summary', 'belief', 'rule', 'memory_health')
    ),
    description        TEXT        NOT NULL,
    requires_evidence  BOOLEAN     NOT NULL DEFAULT TRUE,
    derivation_policy  JSONB       NOT NULL DEFAULT '{}',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO preserve.reflection_class (
    class_key, parent_class_key, display_name, target_kind, description, derivation_policy
) VALUES
    (
        'entity_summary',
        NULL,
        'Entity summary',
        'entity_summary',
        'Evidence-linked derived summary for one entity.',
        '{"minimum_evidence_links": 1}'::jsonb
    ),
    (
        'belief',
        NULL,
        'Belief',
        'belief',
        'Evidence-linked non-fact assertion that remains distinct from preserve.fact.',
        '{"minimum_evidence_links": 1, "may_be_wrong": true}'::jsonb
    ),
    (
        'rule',
        NULL,
        'Rule',
        'rule',
        'Evidence-linked derived rule, heuristic, policy, or preference.',
        '{"minimum_evidence_links": 1}'::jsonb
    ),
    (
        'memory_health',
        NULL,
        'Memory health',
        'memory_health',
        'Evidence-linked assessment of memory coverage, staleness, and support quality.',
        '{"minimum_usage_snapshots": 1}'::jsonb
    )
ON CONFLICT (class_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_reflection_class_target_kind
    ON preserve.reflection_class (target_kind);

CREATE TABLE IF NOT EXISTS preserve.entity_summary (
    summary_id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                       TEXT                         NOT NULL,
    entity_id                    UUID                         NOT NULL REFERENCES preserve.entity(entity_id),
    class_key                    TEXT                         NOT NULL DEFAULT 'entity_summary'
                                                              REFERENCES preserve.reflection_class(class_key),
    summary_fingerprint          TEXT                         NOT NULL,
    summary_text                 TEXT                         NOT NULL,
    summary_json                 JSONB                        NOT NULL DEFAULT '{}',
    confidence                   NUMERIC(3,2)                 NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    assertion_class              preserve.assertion_class     NOT NULL,
    lifecycle_state              preserve.lifecycle_state     NOT NULL DEFAULT 'draft',
    support_count                INTEGER                      NOT NULL DEFAULT 1 CHECK (support_count > 0),
    contradiction_count          INTEGER                      NOT NULL DEFAULT 0 CHECK (contradiction_count >= 0),
    primary_evidence_segment_id  UUID                         NOT NULL REFERENCES preserve.segment(segment_id),
    scope_path                   TEXT,
    created_run_id               UUID                         REFERENCES preserve.extraction_run(run_id),
    created_at                   TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    updated_at                   TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT uq_entity_summary_tenant_fingerprint UNIQUE (tenant, summary_fingerprint),
    CONSTRAINT chk_entity_summary_class CHECK (class_key = 'entity_summary')
);

CREATE INDEX IF NOT EXISTS idx_entity_summary_entity
    ON preserve.entity_summary (tenant, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_summary_lifecycle
    ON preserve.entity_summary (tenant, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_entity_summary_scope_path
    ON preserve.entity_summary (tenant, scope_path);
CREATE INDEX IF NOT EXISTS idx_entity_summary_evidence_segment
    ON preserve.entity_summary (primary_evidence_segment_id);

CREATE TABLE IF NOT EXISTS preserve.entity_summary_evidence (
    summary_evidence_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    summary_id           UUID         NOT NULL REFERENCES preserve.entity_summary(summary_id) ON DELETE CASCADE,
    fact_id              UUID         REFERENCES preserve.fact(fact_id),
    episode_id           UUID         REFERENCES preserve.episode(episode_id),
    segment_id           UUID         REFERENCES preserve.segment(segment_id),
    memory_id            UUID         REFERENCES preserve.memory(memory_id),
    edge_id              UUID         REFERENCES preserve.memory_edge(edge_id),
    event_frame_id       UUID         REFERENCES preserve.event_frame(event_frame_id),
    evidence_role        TEXT         NOT NULL DEFAULT 'supporting' CHECK (
        evidence_role IN ('supporting', 'counter', 'context')
    ),
    weight               NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
    notes                TEXT,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT chk_entity_summary_evidence_has_source CHECK (
        fact_id IS NOT NULL
        OR episode_id IS NOT NULL
        OR segment_id IS NOT NULL
        OR memory_id IS NOT NULL
        OR edge_id IS NOT NULL
        OR event_frame_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_entity_summary_evidence_summary
    ON preserve.entity_summary_evidence (summary_id);
CREATE INDEX IF NOT EXISTS idx_entity_summary_evidence_fact
    ON preserve.entity_summary_evidence (fact_id);
CREATE INDEX IF NOT EXISTS idx_entity_summary_evidence_segment
    ON preserve.entity_summary_evidence (segment_id);

CREATE TABLE IF NOT EXISTS preserve.belief (
    belief_id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                       TEXT                         NOT NULL,
    class_key                    TEXT                         NOT NULL DEFAULT 'belief'
                                                              REFERENCES preserve.reflection_class(class_key),
    belief_fingerprint           TEXT                         NOT NULL,
    subject_entity_id            UUID                         REFERENCES preserve.entity(entity_id),
    project_entity_id            UUID                         REFERENCES preserve.entity(entity_id),
    belief_kind                  TEXT                         NOT NULL CHECK (
        belief_kind IN ('hypothesis', 'preference', 'inference', 'expectation', 'risk')
    ),
    belief_text                  TEXT                         NOT NULL,
    belief_json                  JSONB                        NOT NULL DEFAULT '{}',
    confidence                   NUMERIC(3,2)                 NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    assertion_class              preserve.assertion_class     NOT NULL,
    truth_status                 TEXT                         NOT NULL DEFAULT 'unverified' CHECK (
        truth_status IN ('unverified', 'supported', 'contradicted', 'retired')
    ),
    support_count                INTEGER                      NOT NULL DEFAULT 1 CHECK (support_count > 0),
    contradiction_count          INTEGER                      NOT NULL DEFAULT 0 CHECK (contradiction_count >= 0),
    primary_evidence_segment_id  UUID                         NOT NULL REFERENCES preserve.segment(segment_id),
    scope_path                   TEXT,
    created_run_id               UUID                         REFERENCES preserve.extraction_run(run_id),
    created_at                   TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    updated_at                   TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT uq_belief_tenant_fingerprint UNIQUE (tenant, belief_fingerprint),
    CONSTRAINT chk_belief_class CHECK (class_key = 'belief'),
    CONSTRAINT chk_belief_not_deterministic_fact CHECK (assertion_class <> 'deterministic')
);

CREATE INDEX IF NOT EXISTS idx_belief_subject
    ON preserve.belief (tenant, subject_entity_id);
CREATE INDEX IF NOT EXISTS idx_belief_project
    ON preserve.belief (tenant, project_entity_id);
CREATE INDEX IF NOT EXISTS idx_belief_kind_status
    ON preserve.belief (tenant, belief_kind, truth_status);
CREATE INDEX IF NOT EXISTS idx_belief_scope_path
    ON preserve.belief (tenant, scope_path);
CREATE INDEX IF NOT EXISTS idx_belief_evidence_segment
    ON preserve.belief (primary_evidence_segment_id);

CREATE TABLE IF NOT EXISTS preserve.belief_evidence (
    belief_evidence_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    belief_id           UUID         NOT NULL REFERENCES preserve.belief(belief_id) ON DELETE CASCADE,
    fact_id             UUID         REFERENCES preserve.fact(fact_id),
    episode_id          UUID         REFERENCES preserve.episode(episode_id),
    segment_id          UUID         REFERENCES preserve.segment(segment_id),
    memory_id           UUID         REFERENCES preserve.memory(memory_id),
    edge_id             UUID         REFERENCES preserve.memory_edge(edge_id),
    event_frame_id      UUID         REFERENCES preserve.event_frame(event_frame_id),
    evidence_role       TEXT         NOT NULL DEFAULT 'supporting' CHECK (
        evidence_role IN ('supporting', 'counter', 'context')
    ),
    weight              NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
    notes               TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT chk_belief_evidence_has_source CHECK (
        fact_id IS NOT NULL
        OR episode_id IS NOT NULL
        OR segment_id IS NOT NULL
        OR memory_id IS NOT NULL
        OR edge_id IS NOT NULL
        OR event_frame_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_belief_evidence_belief
    ON preserve.belief_evidence (belief_id);
CREATE INDEX IF NOT EXISTS idx_belief_evidence_fact
    ON preserve.belief_evidence (fact_id);
CREATE INDEX IF NOT EXISTS idx_belief_evidence_segment
    ON preserve.belief_evidence (segment_id);

CREATE TABLE IF NOT EXISTS preserve.rule (
    rule_id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                       TEXT                         NOT NULL,
    class_key                    TEXT                         NOT NULL DEFAULT 'rule'
                                                              REFERENCES preserve.reflection_class(class_key),
    rule_fingerprint             TEXT                         NOT NULL,
    subject_entity_id            UUID                         REFERENCES preserve.entity(entity_id),
    project_entity_id            UUID                         REFERENCES preserve.entity(entity_id),
    rule_kind                    TEXT                         NOT NULL CHECK (
        rule_kind IN ('heuristic', 'procedure', 'policy', 'preference', 'guardrail')
    ),
    condition_text               TEXT                         NOT NULL,
    action_text                  TEXT                         NOT NULL,
    rationale                    TEXT,
    rule_json                    JSONB                        NOT NULL DEFAULT '{}',
    confidence                   NUMERIC(3,2)                 NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    assertion_class              preserve.assertion_class     NOT NULL,
    lifecycle_state              preserve.lifecycle_state     NOT NULL DEFAULT 'draft',
    support_count                INTEGER                      NOT NULL DEFAULT 1 CHECK (support_count > 0),
    contradiction_count          INTEGER                      NOT NULL DEFAULT 0 CHECK (contradiction_count >= 0),
    primary_evidence_segment_id  UUID                         NOT NULL REFERENCES preserve.segment(segment_id),
    scope_path                   TEXT,
    created_run_id               UUID                         REFERENCES preserve.extraction_run(run_id),
    created_at                   TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    updated_at                   TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT uq_rule_tenant_fingerprint UNIQUE (tenant, rule_fingerprint),
    CONSTRAINT chk_rule_class CHECK (class_key = 'rule')
);

CREATE INDEX IF NOT EXISTS idx_rule_subject
    ON preserve.rule (tenant, subject_entity_id);
CREATE INDEX IF NOT EXISTS idx_rule_project
    ON preserve.rule (tenant, project_entity_id);
CREATE INDEX IF NOT EXISTS idx_rule_kind_lifecycle
    ON preserve.rule (tenant, rule_kind, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_rule_scope_path
    ON preserve.rule (tenant, scope_path);
CREATE INDEX IF NOT EXISTS idx_rule_evidence_segment
    ON preserve.rule (primary_evidence_segment_id);

CREATE TABLE IF NOT EXISTS preserve.rule_evidence (
    rule_evidence_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id             UUID         NOT NULL REFERENCES preserve.rule(rule_id) ON DELETE CASCADE,
    fact_id             UUID         REFERENCES preserve.fact(fact_id),
    episode_id          UUID         REFERENCES preserve.episode(episode_id),
    segment_id          UUID         REFERENCES preserve.segment(segment_id),
    memory_id           UUID         REFERENCES preserve.memory(memory_id),
    edge_id             UUID         REFERENCES preserve.memory_edge(edge_id),
    event_frame_id      UUID         REFERENCES preserve.event_frame(event_frame_id),
    evidence_role       TEXT         NOT NULL DEFAULT 'supporting' CHECK (
        evidence_role IN ('supporting', 'counter', 'context')
    ),
    weight              NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
    notes               TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT chk_rule_evidence_has_source CHECK (
        fact_id IS NOT NULL
        OR episode_id IS NOT NULL
        OR segment_id IS NOT NULL
        OR memory_id IS NOT NULL
        OR edge_id IS NOT NULL
        OR event_frame_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_rule_evidence_rule
    ON preserve.rule_evidence (rule_id);
CREATE INDEX IF NOT EXISTS idx_rule_evidence_fact
    ON preserve.rule_evidence (fact_id);
CREATE INDEX IF NOT EXISTS idx_rule_evidence_segment
    ON preserve.rule_evidence (segment_id);

CREATE TABLE IF NOT EXISTS preserve.memory_usage (
    usage_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant               TEXT           NOT NULL,
    scope_path           TEXT,
    measured_at          TIMESTAMPTZ    NOT NULL DEFAULT now(),
    source               TEXT           NOT NULL DEFAULT 'manual',
    usage_fingerprint    TEXT           NOT NULL,
    total_memory_count   INTEGER        NOT NULL DEFAULT 0 CHECK (total_memory_count >= 0),
    published_count      INTEGER        NOT NULL DEFAULT 0 CHECK (published_count >= 0),
    draft_count          INTEGER        NOT NULL DEFAULT 0 CHECK (draft_count >= 0),
    retired_count        INTEGER        NOT NULL DEFAULT 0 CHECK (retired_count >= 0),
    unsupported_count    INTEGER        NOT NULL DEFAULT 0 CHECK (unsupported_count >= 0),
    stale_count          INTEGER        NOT NULL DEFAULT 0 CHECK (stale_count >= 0),
    contradiction_count  INTEGER        NOT NULL DEFAULT 0 CHECK (contradiction_count >= 0),
    avg_confidence       NUMERIC(3,2)   CHECK (avg_confidence IS NULL OR (avg_confidence >= 0 AND avg_confidence <= 1)),
    byte_estimate        BIGINT         CHECK (byte_estimate IS NULL OR byte_estimate >= 0),
    metrics              JSONB          NOT NULL DEFAULT '{}',
    created_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT uq_memory_usage_tenant_fingerprint UNIQUE (tenant, usage_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_memory_usage_tenant_measured
    ON preserve.memory_usage (tenant, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_usage_scope
    ON preserve.memory_usage (tenant, scope_path);

CREATE TABLE IF NOT EXISTS preserve.memory_health (
    health_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant               TEXT                         NOT NULL,
    class_key            TEXT                         NOT NULL DEFAULT 'memory_health'
                                                         REFERENCES preserve.reflection_class(class_key),
    health_fingerprint   TEXT                         NOT NULL,
    usage_id             UUID                         NOT NULL REFERENCES preserve.memory_usage(usage_id),
    scope_path           TEXT,
    status               TEXT                         NOT NULL CHECK (
        status IN ('healthy', 'watch', 'degraded', 'critical')
    ),
    risk_score           NUMERIC(3,2)                 NOT NULL CHECK (risk_score >= 0 AND risk_score <= 1),
    assessment_text      TEXT                         NOT NULL,
    recommendations      JSONB                        NOT NULL DEFAULT '[]',
    assertion_class      preserve.assertion_class     NOT NULL DEFAULT 'corroborated_llm',
    created_run_id       UUID                         REFERENCES preserve.extraction_run(run_id),
    assessed_at          TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    created_at           TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT uq_memory_health_tenant_fingerprint UNIQUE (tenant, health_fingerprint),
    CONSTRAINT chk_memory_health_class CHECK (class_key = 'memory_health')
);

CREATE INDEX IF NOT EXISTS idx_memory_health_status
    ON preserve.memory_health (tenant, status, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_health_usage
    ON preserve.memory_health (usage_id);
CREATE INDEX IF NOT EXISTS idx_memory_health_scope
    ON preserve.memory_health (tenant, scope_path);

CREATE TABLE IF NOT EXISTS preserve.memory_health_evidence (
    health_evidence_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    health_id           UUID         NOT NULL REFERENCES preserve.memory_health(health_id) ON DELETE CASCADE,
    usage_id            UUID         REFERENCES preserve.memory_usage(usage_id),
    memory_id           UUID         REFERENCES preserve.memory(memory_id),
    fact_id             UUID         REFERENCES preserve.fact(fact_id),
    segment_id          UUID         REFERENCES preserve.segment(segment_id),
    evidence_role       TEXT         NOT NULL DEFAULT 'supporting' CHECK (
        evidence_role IN ('supporting', 'counter', 'context')
    ),
    weight              NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
    notes               TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT chk_memory_health_evidence_has_source CHECK (
        usage_id IS NOT NULL
        OR memory_id IS NOT NULL
        OR fact_id IS NOT NULL
        OR segment_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_memory_health_evidence_health
    ON preserve.memory_health_evidence (health_id);
CREATE INDEX IF NOT EXISTS idx_memory_health_evidence_usage
    ON preserve.memory_health_evidence (usage_id);
CREATE INDEX IF NOT EXISTS idx_memory_health_evidence_memory
    ON preserve.memory_health_evidence (memory_id);

DROP TRIGGER IF EXISTS trg_reflection_class_updated_at ON preserve.reflection_class;
CREATE TRIGGER trg_reflection_class_updated_at
    BEFORE UPDATE ON preserve.reflection_class
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();

DROP TRIGGER IF EXISTS trg_entity_summary_updated_at ON preserve.entity_summary;
CREATE TRIGGER trg_entity_summary_updated_at
    BEFORE UPDATE ON preserve.entity_summary
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();

DROP TRIGGER IF EXISTS trg_belief_updated_at ON preserve.belief;
CREATE TRIGGER trg_belief_updated_at
    BEFORE UPDATE ON preserve.belief
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();

DROP TRIGGER IF EXISTS trg_rule_updated_at ON preserve.rule;
CREATE TRIGGER trg_rule_updated_at
    BEFORE UPDATE ON preserve.rule
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();

DROP TRIGGER IF EXISTS trg_memory_health_updated_at ON preserve.memory_health;
CREATE TRIGGER trg_memory_health_updated_at
    BEFORE UPDATE ON preserve.memory_health
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();
