-- BrainCore Preserve Schema: active agent session working memory.
--
-- Session working memory is transient by default. Promotion into durable
-- preserve.memory must cross an explicit status boundary and retain an
-- evidence anchor so session notes do not silently become facts.

SET search_path TO preserve, public;

CREATE TABLE IF NOT EXISTS preserve.task_session (
    session_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant              TEXT        NOT NULL,
    session_key         TEXT        NOT NULL,
    agent_name          TEXT        NOT NULL,
    task_title          TEXT,
    status              TEXT        NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'idle', 'completed', 'failed', 'expired')
    ),
    source_artifact_id  UUID        REFERENCES preserve.artifact(artifact_id) ON DELETE SET NULL,
    parent_session_id   UUID        REFERENCES preserve.task_session(session_id) ON DELETE SET NULL,
    scope_entity_id     UUID        REFERENCES preserve.entity(entity_id),
    project_entity_id   UUID        REFERENCES preserve.entity(entity_id),
    scope_path          TEXT,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at            TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,
    session_json        JSONB       NOT NULL DEFAULT '{}',
    created_run_id      UUID        REFERENCES preserve.extraction_run(run_id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_task_session_tenant_key UNIQUE (tenant, session_key),
    CONSTRAINT uq_task_session_tenant_id UNIQUE (tenant, session_id),
    CONSTRAINT chk_task_session_time_range CHECK (
        ended_at IS NULL OR started_at <= ended_at
    ),
    CONSTRAINT chk_task_session_expiry CHECK (
        expires_at IS NULL OR started_at <= expires_at
    )
);

CREATE INDEX IF NOT EXISTS idx_task_session_tenant_status
    ON preserve.task_session (tenant, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_session_source_artifact
    ON preserve.task_session (tenant, source_artifact_id);
CREATE INDEX IF NOT EXISTS idx_task_session_parent
    ON preserve.task_session (tenant, parent_session_id);
CREATE INDEX IF NOT EXISTS idx_task_session_scope_entity
    ON preserve.task_session (tenant, scope_entity_id);
CREATE INDEX IF NOT EXISTS idx_task_session_project_entity
    ON preserve.task_session (tenant, project_entity_id);
CREATE INDEX IF NOT EXISTS idx_task_session_scope_path
    ON preserve.task_session (tenant, scope_path);
CREATE INDEX IF NOT EXISTS idx_task_session_expiry
    ON preserve.task_session (tenant, expires_at)
    WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS preserve.working_memory (
    working_memory_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                     TEXT        NOT NULL,
    session_id                 UUID        NOT NULL,
    working_memory_fingerprint TEXT        NOT NULL,
    memory_kind                TEXT        NOT NULL CHECK (
        memory_kind IN ('context', 'observation', 'plan', 'decision', 'risk', 'handoff')
    ),
    content                    TEXT        NOT NULL,
    content_json               JSONB       NOT NULL DEFAULT '{}',
    source_segment_id          UUID        REFERENCES preserve.segment(segment_id) ON DELETE SET NULL,
    source_fact_id             UUID        REFERENCES preserve.fact(fact_id) ON DELETE SET NULL,
    evidence_segment_id        UUID        REFERENCES preserve.segment(segment_id) ON DELETE SET NULL,
    confidence                 NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
    promotion_status           TEXT        NOT NULL DEFAULT 'not_promoted' CHECK (
        promotion_status IN (
            'not_promoted',
            'promotion_candidate',
            'promoted',
            'rejected',
            'expired'
        )
    ),
    promotion_reason           TEXT,
    promotion_block_reason     TEXT,
    promoted_memory_id         UUID        REFERENCES preserve.memory(memory_id) ON DELETE SET NULL,
    expires_at                 TIMESTAMPTZ NOT NULL,
    created_run_id             UUID        REFERENCES preserve.extraction_run(run_id),
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_working_memory_tenant_session FOREIGN KEY (tenant, session_id)
        REFERENCES preserve.task_session(tenant, session_id) ON DELETE CASCADE,
    CONSTRAINT uq_working_memory_tenant_fingerprint UNIQUE (
        tenant,
        working_memory_fingerprint
    ),
    CONSTRAINT chk_working_memory_has_expiry CHECK (created_at <= expires_at),
    CONSTRAINT chk_working_memory_promotion_has_evidence CHECK (
        promotion_status NOT IN ('promotion_candidate', 'promoted')
        OR evidence_segment_id IS NOT NULL
        OR source_segment_id IS NOT NULL
        OR source_fact_id IS NOT NULL
    ),
    CONSTRAINT chk_working_memory_promoted_target CHECK (
        (promotion_status = 'promoted' AND promoted_memory_id IS NOT NULL)
        OR (promotion_status <> 'promoted' AND promoted_memory_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_working_memory_session
    ON preserve.working_memory (tenant, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_working_memory_kind
    ON preserve.working_memory (tenant, memory_kind);
CREATE INDEX IF NOT EXISTS idx_working_memory_promotion_status
    ON preserve.working_memory (tenant, promotion_status);
CREATE INDEX IF NOT EXISTS idx_working_memory_expiry
    ON preserve.working_memory (tenant, expires_at);
CREATE INDEX IF NOT EXISTS idx_working_memory_source_segment
    ON preserve.working_memory (source_segment_id);
CREATE INDEX IF NOT EXISTS idx_working_memory_source_fact
    ON preserve.working_memory (source_fact_id);
CREATE INDEX IF NOT EXISTS idx_working_memory_evidence_segment
    ON preserve.working_memory (evidence_segment_id);
CREATE INDEX IF NOT EXISTS idx_working_memory_promoted_memory
    ON preserve.working_memory (tenant, promoted_memory_id);

DROP TRIGGER IF EXISTS trg_task_session_updated_at ON preserve.task_session;
CREATE TRIGGER trg_task_session_updated_at
    BEFORE UPDATE ON preserve.task_session
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();

DROP TRIGGER IF EXISTS trg_working_memory_updated_at ON preserve.working_memory;
CREATE TRIGGER trg_working_memory_updated_at
    BEFORE UPDATE ON preserve.working_memory
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();
