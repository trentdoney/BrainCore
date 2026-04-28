-- BrainCore Preserve Schema: event-centric episodic memory frames.
--
-- Event frames make incident/session episodes queryable as structured actions
-- without replacing grounded facts. Each frame keeps a source fact and evidence
-- pointer so higher-level timeline/causal retrieval remains auditable.

CREATE TABLE IF NOT EXISTS preserve.event_frame (
    event_frame_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant               TEXT                         NOT NULL,
    frame_fingerprint    TEXT                         NOT NULL,
    episode_id           UUID                         NOT NULL REFERENCES preserve.episode(episode_id) ON DELETE CASCADE,
    event_id             UUID                         REFERENCES preserve.event(event_id) ON DELETE SET NULL,
    source_fact_id       UUID                         REFERENCES preserve.fact(fact_id) ON DELETE SET NULL,
    event_type           TEXT                         NOT NULL,
    actor_entity_id      UUID                         REFERENCES preserve.entity(entity_id),
    action               TEXT                         NOT NULL,
    target_entity_id     UUID                         REFERENCES preserve.entity(entity_id),
    object_value         JSONB,
    time_start           TIMESTAMPTZ,
    time_end             TIMESTAMPTZ,
    location_entity_id   UUID                         REFERENCES preserve.entity(entity_id),
    cause_fact_id        UUID                         REFERENCES preserve.fact(fact_id),
    effect_fact_id       UUID                         REFERENCES preserve.fact(fact_id),
    outcome              TEXT,
    confidence           NUMERIC(3,2)                 NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    assertion_class      preserve.assertion_class     NOT NULL,
    evidence_segment_id  UUID                         REFERENCES preserve.segment(segment_id),
    scope_path           TEXT,
    frame_json           JSONB                        NOT NULL DEFAULT '{}',
    created_run_id       UUID                         REFERENCES preserve.extraction_run(run_id),
    created_at           TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_frame_tenant_fingerprint UNIQUE (tenant, frame_fingerprint),
    CONSTRAINT chk_event_frame_time_range CHECK (
        time_start IS NULL OR time_end IS NULL OR time_start <= time_end
    )
);

CREATE INDEX IF NOT EXISTS idx_event_frame_episode
    ON preserve.event_frame (tenant, episode_id, time_start);
CREATE INDEX IF NOT EXISTS idx_event_frame_source_fact
    ON preserve.event_frame (tenant, source_fact_id);
CREATE INDEX IF NOT EXISTS idx_event_frame_type_time
    ON preserve.event_frame (tenant, event_type, time_start);
CREATE INDEX IF NOT EXISTS idx_event_frame_actor
    ON preserve.event_frame (tenant, actor_entity_id);
CREATE INDEX IF NOT EXISTS idx_event_frame_target
    ON preserve.event_frame (tenant, target_entity_id);
CREATE INDEX IF NOT EXISTS idx_event_frame_cause
    ON preserve.event_frame (tenant, cause_fact_id);
CREATE INDEX IF NOT EXISTS idx_event_frame_effect
    ON preserve.event_frame (tenant, effect_fact_id);
CREATE INDEX IF NOT EXISTS idx_event_frame_evidence
    ON preserve.event_frame (evidence_segment_id);
CREATE INDEX IF NOT EXISTS idx_event_frame_scope_path
    ON preserve.event_frame (tenant, scope_path);

DROP TRIGGER IF EXISTS trg_event_frame_updated_at ON preserve.event_frame;
CREATE TRIGGER trg_event_frame_updated_at
    BEFORE UPDATE ON preserve.event_frame
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();
