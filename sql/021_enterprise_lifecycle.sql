-- BrainCore Phase 5: enterprise memory lifecycle layer.
--
-- This migration is additive. It adds lifecycle event intake, recall/admin
-- intelligence, cues, feedback, and append-only audit surfaces without
-- replacing BrainCore's evidence-first fact/memory/procedure/event-frame
-- tables.

SET search_path TO preserve, public;

CREATE TABLE IF NOT EXISTS preserve.lifecycle_outbox (
    outbox_id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                      TEXT NOT NULL,
    event_id                    TEXT NOT NULL,
    idempotency_key             TEXT NOT NULL,
    event_type                  TEXT NOT NULL CHECK (
        event_type IN (
            'mission_started','mission_completed','mission_failed',
            'session_started','session_completed','session_failed',
            'model_call_started','model_call_completed','model_call_failed',
            'tool_called','tool_completed','tool_failed',
            'approval_decided','user_corrected','context_compacted',
            'memory_retrieved','memory_injected','memory_omitted',
            'memory_feedback','memory_written','memory_suppressed',
            'memory_retired','memory_promoted',
            'admin_memory_suppressed','admin_memory_retired',
            'admin_memory_promoted','admin_memory_disputed',
            'admin_feedback_resolved','admin_policy_override',
            'artifact_archived','extraction_completed','fact_inserted',
            'memory_consolidated','procedure_used','working_memory_added',
            'working_memory_promoted'
        )
    ),
    source_service              TEXT NOT NULL,
    status                      TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending','processing','completed','failed','dead_letter')
    ),
    scope_path                  TEXT,
    project_entity_id           UUID REFERENCES preserve.entity(entity_id),
    session_id                  UUID REFERENCES preserve.task_session(session_id),
    session_key                 TEXT,
    task_id                     TEXT,
    trace_id                    TEXT,
    span_id                     TEXT,
    target_kind                 TEXT CHECK (
        target_kind IS NULL OR target_kind IN ('fact','memory','procedure','event_frame','working_memory')
    ),
    target_id                   UUID,
    actor_type                  TEXT,
    actor_id                    TEXT,
    occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at                  TIMESTAMPTZ,
    claimed_by                  TEXT,
    claim_timeout_ms            INTEGER NOT NULL DEFAULT 120000 CHECK (
        claim_timeout_ms BETWEEN 30000 AND 600000
    ),
    attempt_count               INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts                INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 25),
    next_attempt_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at                TIMESTAMPTZ,
    dead_lettered_at            TIMESTAMPTZ,
    dead_letter_retained_until  TIMESTAMPTZ,
    error_summary               TEXT,
    error_history               JSONB NOT NULL DEFAULT '[]',
    sensitivity_class           TEXT,
    redaction_status            TEXT NOT NULL DEFAULT 'redacted',
    payload                     JSONB NOT NULL DEFAULT '{}',
    evidence_refs               JSONB NOT NULL DEFAULT '[]',
    produced_target_kind        TEXT CHECK (
        produced_target_kind IS NULL OR produced_target_kind IN ('fact','memory','procedure','event_frame','working_memory')
    ),
    produced_target_id          UUID,
    schema_version              INTEGER NOT NULL DEFAULT 1,
    config_version              TEXT NOT NULL DEFAULT 'braincore-lifecycle-v1',
    CONSTRAINT uq_lifecycle_outbox_tenant_idempotency UNIQUE (tenant, idempotency_key),
    CONSTRAINT chk_lifecycle_outbox_target_pair CHECK (
        (target_kind IS NULL AND target_id IS NULL)
        OR (target_kind IS NOT NULL AND target_id IS NOT NULL)
    ),
    CONSTRAINT chk_lifecycle_outbox_produced_pair CHECK (
        (produced_target_kind IS NULL AND produced_target_id IS NULL)
        OR (produced_target_kind IS NOT NULL AND produced_target_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_claim
    ON preserve.lifecycle_outbox (tenant, status, next_attempt_at, received_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_event_type
    ON preserve.lifecycle_outbox (tenant, event_type, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_target
    ON preserve.lifecycle_outbox (tenant, target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_status_claimed
    ON preserve.lifecycle_outbox (tenant, status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_outbox_dead_lettered
    ON preserve.lifecycle_outbox (tenant, dead_lettered_at)
    WHERE status = 'dead_letter';

CREATE TABLE IF NOT EXISTS preserve.lifecycle_target_intelligence (
    intelligence_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                TEXT NOT NULL,
    target_kind           TEXT NOT NULL CHECK (
        target_kind IN ('fact','memory','procedure','event_frame','working_memory')
    ),
    target_id             UUID NOT NULL,
    source_derivation_type TEXT NOT NULL DEFAULT 'system_inferred' CHECK (
        source_derivation_type IN (
            'observed','user_stated','system_inferred','summary_derived',
            'replay_derived','imported_knowledge','corrected_by_user',
            'extraction_derived','consolidation_derived','feedback_derived'
        )
    ),
    horizon               TEXT NOT NULL DEFAULT 'semantic' CHECK (
        horizon IN ('working','episodic','semantic','procedural','policy')
    ),
    lifecycle_status      TEXT NOT NULL DEFAULT 'active' CHECK (
        lifecycle_status IN ('candidate','archived','active','review_required','validated','disputed','suppressed','retired')
    ),
    salience              NUMERIC(4,3) NOT NULL DEFAULT 0.500 CHECK (salience >= 0 AND salience <= 1),
    strength              NUMERIC(4,3) NOT NULL DEFAULT 0.500 CHECK (strength >= 0 AND strength <= 1),
    stability             NUMERIC(4,3) NOT NULL DEFAULT 0.500 CHECK (stability >= 0 AND stability <= 1),
    quality_score         NUMERIC(4,3) NOT NULL DEFAULT 0.500 CHECK (quality_score >= 0 AND quality_score <= 1),
    summary_fidelity_score NUMERIC(4,3) CHECK (
        summary_fidelity_score IS NULL OR (summary_fidelity_score >= 0 AND summary_fidelity_score <= 1)
    ),
    support_count         INTEGER NOT NULL DEFAULT 0 CHECK (support_count >= 0),
    contradiction_count   INTEGER NOT NULL DEFAULT 0 CHECK (contradiction_count >= 0),
    last_reinforced_at    TIMESTAMPTZ,
    last_decayed_at       TIMESTAMPTZ,
    expires_at            TIMESTAMPTZ,
    schema_version        INTEGER NOT NULL DEFAULT 1,
    config_version        TEXT NOT NULL DEFAULT 'braincore-lifecycle-v1',
    metadata              JSONB NOT NULL DEFAULT '{}',
    lock_version          INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_lifecycle_intelligence_target UNIQUE (tenant, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_intelligence_target
    ON preserve.lifecycle_target_intelligence (tenant, target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_intelligence_status
    ON preserve.lifecycle_target_intelligence (tenant, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_lifecycle_intelligence_horizon
    ON preserve.lifecycle_target_intelligence (tenant, horizon);
CREATE INDEX IF NOT EXISTS idx_lifecycle_intelligence_quality
    ON preserve.lifecycle_target_intelligence (tenant, quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_intelligence_expires
    ON preserve.lifecycle_target_intelligence (tenant, expires_at)
    WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS preserve.lifecycle_cue (
    cue_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant             TEXT NOT NULL,
    target_kind        TEXT NOT NULL CHECK (
        target_kind IN ('fact','memory','procedure','event_frame','working_memory')
    ),
    target_id          UUID NOT NULL,
    cue_text           TEXT NOT NULL,
    cue_hash           TEXT NOT NULL,
    cue_type           TEXT NOT NULL CHECK (
        cue_type IN ('entity','action','tool','failure_mode','goal','file_path','policy','user_preference','environment','project','procedure','session')
    ),
    extraction_method  TEXT NOT NULL CHECK (extraction_method IN ('template','keyword','entity','llm','manual')),
    confidence         NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    usefulness_score   NUMERIC(4,3) NOT NULL DEFAULT 0.500 CHECK (usefulness_score >= 0 AND usefulness_score <= 1),
    evidence_ref       JSONB,
    last_used_at       TIMESTAMPTZ,
    success_count      INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
    failure_count      INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_lifecycle_cue_target_hash UNIQUE (tenant, target_kind, target_id, cue_hash)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_cue_hash
    ON preserve.lifecycle_cue (tenant, cue_hash);
CREATE INDEX IF NOT EXISTS idx_lifecycle_cue_target
    ON preserve.lifecycle_cue (tenant, target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_cue_usefulness
    ON preserve.lifecycle_cue (tenant, usefulness_score DESC);

CREATE TABLE IF NOT EXISTS preserve.context_recall_audit (
    context_audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant           TEXT NOT NULL,
    trigger          TEXT NOT NULL CHECK (
        trigger IN ('session_start','mission_start','pre_model_call','tool_failure','task_failure','context_compacted','memory_protocol')
    ),
    mode             TEXT NOT NULL CHECK (mode IN ('off','shadow','eval','default_on')),
    injected         BOOLEAN NOT NULL DEFAULT false,
    scope_path       TEXT,
    project_entity_id UUID REFERENCES preserve.entity(entity_id),
    session_id       UUID REFERENCES preserve.task_session(session_id),
    session_key      TEXT,
    task_id          TEXT,
    trace_id         TEXT,
    span_id          TEXT,
    actor_type       TEXT,
    actor_id         TEXT,
    goal             TEXT,
    cues             JSONB NOT NULL DEFAULT '[]',
    relevance_reason TEXT,
    query_plan       JSONB NOT NULL DEFAULT '{}',
    retrieved        JSONB NOT NULL DEFAULT '[]',
    prompt_package   JSONB NOT NULL DEFAULT '[]',
    omitted          JSONB NOT NULL DEFAULT '[]',
    total_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
    max_tokens       INTEGER NOT NULL CHECK (max_tokens > 0),
    config_version   TEXT NOT NULL DEFAULT 'braincore-lifecycle-v1',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_context_recall_audit_created
    ON preserve.context_recall_audit (tenant, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_recall_audit_trigger_mode
    ON preserve.context_recall_audit (tenant, trigger, mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_recall_audit_session
    ON preserve.context_recall_audit (tenant, session_key, created_at DESC);

CREATE TABLE IF NOT EXISTS preserve.lifecycle_feedback_event (
    feedback_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant           TEXT NOT NULL,
    target_kind      TEXT NOT NULL CHECK (
        target_kind IN ('fact','memory','procedure','event_frame','working_memory')
    ),
    target_id        UUID NOT NULL,
    context_audit_id UUID REFERENCES preserve.context_recall_audit(context_audit_id),
    signal           TEXT NOT NULL CHECK (
        signal IN ('retrieved_not_injected','injected_referenced','injected_ignored','injected_contradicted','led_to_success','led_to_failure','user_corrected','user_confirmed','admin_suppressed','admin_promoted')
    ),
    outcome          TEXT,
    score_delta      JSONB NOT NULL DEFAULT '{}',
    actor_type       TEXT,
    actor_id         TEXT,
    scope_path       TEXT,
    evidence_refs    JSONB NOT NULL DEFAULT '[]',
    details          JSONB NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_feedback_target
    ON preserve.lifecycle_feedback_event (tenant, target_kind, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_feedback_signal
    ON preserve.lifecycle_feedback_event (tenant, signal, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_feedback_context
    ON preserve.lifecycle_feedback_event (tenant, context_audit_id);

CREATE TABLE IF NOT EXISTS preserve.lifecycle_score_audit (
    score_audit_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                  TEXT NOT NULL,
    target_kind             TEXT NOT NULL CHECK (
        target_kind IN ('fact','memory','procedure','event_frame','working_memory')
    ),
    target_id               UUID NOT NULL,
    trigger_type            TEXT NOT NULL CHECK (
        trigger_type IN ('write','lifecycle_event','feedback','admin_status_change','context_recall','decay','backfill')
    ),
    previous_salience       NUMERIC(4,3),
    new_salience            NUMERIC(4,3),
    previous_strength       NUMERIC(4,3),
    new_strength            NUMERIC(4,3),
    previous_stability      NUMERIC(4,3),
    new_stability           NUMERIC(4,3),
    previous_quality_score  NUMERIC(4,3),
    new_quality_score       NUMERIC(4,3),
    previous_summary_fidelity_score NUMERIC(4,3),
    new_summary_fidelity_score      NUMERIC(4,3),
    factors                 JSONB NOT NULL DEFAULT '{}',
    outbox_id               UUID REFERENCES preserve.lifecycle_outbox(outbox_id),
    feedback_id             UUID REFERENCES preserve.lifecycle_feedback_event(feedback_id),
    context_audit_id        UUID REFERENCES preserve.context_recall_audit(context_audit_id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_score_audit_target
    ON preserve.lifecycle_score_audit (tenant, target_kind, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS preserve.lifecycle_audit_log (
    audit_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant           TEXT NOT NULL,
    actor_type       TEXT,
    actor_id         TEXT,
    action           TEXT NOT NULL,
    target_kind      TEXT CHECK (
        target_kind IS NULL OR target_kind IN ('fact','memory','procedure','event_frame','working_memory')
    ),
    target_id        UUID,
    outbox_id        UUID REFERENCES preserve.lifecycle_outbox(outbox_id),
    feedback_id      UUID REFERENCES preserve.lifecycle_feedback_event(feedback_id),
    context_audit_id UUID REFERENCES preserve.context_recall_audit(context_audit_id),
    reason           TEXT,
    before_state     JSONB,
    after_state      JSONB,
    details          JSONB NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_audit_target
    ON preserve.lifecycle_audit_log (tenant, target_kind, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_audit_action
    ON preserve.lifecycle_audit_log (tenant, action, created_at DESC);

CREATE OR REPLACE FUNCTION preserve.reject_lifecycle_append_only_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'lifecycle audit/feedback rows are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lifecycle_feedback_append_only ON preserve.lifecycle_feedback_event;
CREATE TRIGGER trg_lifecycle_feedback_append_only
    BEFORE UPDATE OR DELETE ON preserve.lifecycle_feedback_event
    FOR EACH ROW EXECUTE FUNCTION preserve.reject_lifecycle_append_only_mutation();

DROP TRIGGER IF EXISTS trg_lifecycle_score_audit_append_only ON preserve.lifecycle_score_audit;
CREATE TRIGGER trg_lifecycle_score_audit_append_only
    BEFORE UPDATE OR DELETE ON preserve.lifecycle_score_audit
    FOR EACH ROW EXECUTE FUNCTION preserve.reject_lifecycle_append_only_mutation();

DROP TRIGGER IF EXISTS trg_lifecycle_audit_log_append_only ON preserve.lifecycle_audit_log;
CREATE TRIGGER trg_lifecycle_audit_log_append_only
    BEFORE UPDATE OR DELETE ON preserve.lifecycle_audit_log
    FOR EACH ROW EXECUTE FUNCTION preserve.reject_lifecycle_append_only_mutation();

DROP TRIGGER IF EXISTS trg_lifecycle_intelligence_updated_at ON preserve.lifecycle_target_intelligence;
CREATE TRIGGER trg_lifecycle_intelligence_updated_at
    BEFORE UPDATE ON preserve.lifecycle_target_intelligence
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();

DROP TRIGGER IF EXISTS trg_lifecycle_cue_updated_at ON preserve.lifecycle_cue;
CREATE TRIGGER trg_lifecycle_cue_updated_at
    BEFORE UPDATE ON preserve.lifecycle_cue
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();
