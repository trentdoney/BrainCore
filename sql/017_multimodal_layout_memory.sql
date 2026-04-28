-- BrainCore Preserve Schema: multimodal/layout memory + multi-vector index.
--
-- This migration is schema-only. It records media artifacts, visual regions,
-- and multiple embeddings per grounded object without invoking OCR, layout
-- parsing, or model runtimes.

CREATE TABLE IF NOT EXISTS preserve.media_artifact (
    media_artifact_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                 TEXT                         NOT NULL,
    artifact_id            UUID                         NOT NULL REFERENCES preserve.artifact(artifact_id) ON DELETE CASCADE,
    source_segment_id      UUID                         REFERENCES preserve.segment(segment_id) ON DELETE SET NULL,
    project_entity_id      UUID                         REFERENCES preserve.entity(entity_id),
    media_type             TEXT                         NOT NULL,
    mime_type              TEXT,
    sha256                 TEXT                         NOT NULL,
    width_px               INTEGER                      CHECK (width_px IS NULL OR width_px > 0),
    height_px              INTEGER                      CHECK (height_px IS NULL OR height_px > 0),
    duration_ms            INTEGER                      CHECK (duration_ms IS NULL OR duration_ms >= 0),
    page_count             INTEGER                      CHECK (page_count IS NULL OR page_count > 0),
    scope_path             TEXT,
    media_meta             JSONB                        NOT NULL DEFAULT '{}',
    created_run_id         UUID                         REFERENCES preserve.extraction_run(run_id),
    created_at             TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT uq_media_artifact_tenant_artifact UNIQUE (tenant, artifact_id),
    CONSTRAINT uq_media_artifact_tenant_id UNIQUE (tenant, media_artifact_id),
    CONSTRAINT chk_media_artifact_type CHECK (
        media_type IN ('image','video','audio','document','page','screenshot','other')
    )
);

CREATE INDEX IF NOT EXISTS idx_media_artifact_artifact
    ON preserve.media_artifact (tenant, artifact_id);
CREATE INDEX IF NOT EXISTS idx_media_artifact_source_segment
    ON preserve.media_artifact (tenant, source_segment_id);
CREATE INDEX IF NOT EXISTS idx_media_artifact_project_entity
    ON preserve.media_artifact (tenant, project_entity_id);
CREATE INDEX IF NOT EXISTS idx_media_artifact_type
    ON preserve.media_artifact (tenant, media_type);
CREATE INDEX IF NOT EXISTS idx_media_artifact_scope_path
    ON preserve.media_artifact (tenant, scope_path);

CREATE TABLE IF NOT EXISTS preserve.visual_region (
    visual_region_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                 TEXT                         NOT NULL,
    media_artifact_id      UUID                         NOT NULL,
    region_fingerprint     TEXT                         NOT NULL,
    region_type            TEXT                         NOT NULL,
    page_number            INTEGER                      CHECK (page_number IS NULL OR page_number > 0),
    x_min                  NUMERIC(10,6)                NOT NULL,
    y_min                  NUMERIC(10,6)                NOT NULL,
    x_max                  NUMERIC(10,6)                NOT NULL,
    y_max                  NUMERIC(10,6)                NOT NULL,
    coordinate_space       TEXT                         NOT NULL DEFAULT 'normalized',
    label                  TEXT,
    source_segment_id      UUID                         REFERENCES preserve.segment(segment_id) ON DELETE SET NULL,
    linked_entity_id       UUID                         REFERENCES preserve.entity(entity_id),
    linked_fact_id         UUID                         REFERENCES preserve.fact(fact_id) ON DELETE SET NULL,
    linked_memory_id       UUID                         REFERENCES preserve.memory(memory_id) ON DELETE SET NULL,
    linked_event_frame_id  UUID                         REFERENCES preserve.event_frame(event_frame_id) ON DELETE SET NULL,
    linked_procedure_id    UUID                         REFERENCES preserve.procedure(procedure_id) ON DELETE SET NULL,
    confidence             NUMERIC(3,2)                 CHECK (confidence IS NULL OR confidence >= 0 AND confidence <= 1),
    assertion_class        preserve.assertion_class,
    region_meta            JSONB                        NOT NULL DEFAULT '{}',
    created_run_id         UUID                         REFERENCES preserve.extraction_run(run_id),
    created_at             TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT uq_visual_region_tenant_fingerprint UNIQUE (tenant, region_fingerprint),
    CONSTRAINT uq_visual_region_tenant_id UNIQUE (tenant, visual_region_id),
    CONSTRAINT fk_visual_region_tenant_media FOREIGN KEY (tenant, media_artifact_id)
        REFERENCES preserve.media_artifact(tenant, media_artifact_id) ON DELETE CASCADE,
    CONSTRAINT chk_visual_region_type CHECK (
        region_type IN (
            'page',
            'image_region',
            'text_block',
            'table',
            'chart',
            'diagram',
            'ui_element',
            'other'
        )
    ),
    CONSTRAINT chk_visual_region_coordinate_space CHECK (
        coordinate_space IN ('normalized','pixel')
    ),
    CONSTRAINT chk_visual_region_bbox_order CHECK (
        x_min < x_max AND y_min < y_max
    ),
    CONSTRAINT chk_visual_region_bbox_nonnegative CHECK (
        x_min >= 0 AND y_min >= 0 AND x_max >= 0 AND y_max >= 0
    ),
    CONSTRAINT chk_visual_region_normalized_bounds CHECK (
        coordinate_space <> 'normalized'
        OR (x_max <= 1 AND y_max <= 1)
    )
);

CREATE INDEX IF NOT EXISTS idx_visual_region_media
    ON preserve.visual_region (tenant, media_artifact_id, page_number);
CREATE INDEX IF NOT EXISTS idx_visual_region_type
    ON preserve.visual_region (tenant, region_type);
CREATE INDEX IF NOT EXISTS idx_visual_region_source_segment
    ON preserve.visual_region (tenant, source_segment_id);
CREATE INDEX IF NOT EXISTS idx_visual_region_linked_entity
    ON preserve.visual_region (tenant, linked_entity_id);
CREATE INDEX IF NOT EXISTS idx_visual_region_linked_fact
    ON preserve.visual_region (tenant, linked_fact_id);
CREATE INDEX IF NOT EXISTS idx_visual_region_linked_memory
    ON preserve.visual_region (tenant, linked_memory_id);

CREATE TABLE IF NOT EXISTS preserve.embedding_index (
    embedding_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant                 TEXT                         NOT NULL,
    target_kind            TEXT                         NOT NULL,
    vector_role            TEXT                         NOT NULL,
    embedding_model        TEXT                         NOT NULL,
    embedding_dimension    INTEGER                      NOT NULL DEFAULT 384,
    embedding              vector(384)                  NOT NULL,
    embedding_fingerprint  TEXT                         NOT NULL,
    distance_metric        TEXT                         NOT NULL DEFAULT 'cosine',
    artifact_id            UUID                         REFERENCES preserve.artifact(artifact_id) ON DELETE CASCADE,
    segment_id             UUID                         REFERENCES preserve.segment(segment_id) ON DELETE CASCADE,
    entity_id              UUID                         REFERENCES preserve.entity(entity_id) ON DELETE CASCADE,
    fact_id                UUID                         REFERENCES preserve.fact(fact_id) ON DELETE CASCADE,
    memory_id              UUID                         REFERENCES preserve.memory(memory_id) ON DELETE CASCADE,
    media_artifact_id      UUID,
    visual_region_id       UUID,
    event_frame_id         UUID                         REFERENCES preserve.event_frame(event_frame_id) ON DELETE CASCADE,
    procedure_id           UUID                         REFERENCES preserve.procedure(procedure_id) ON DELETE CASCADE,
    source_artifact_id     UUID                         REFERENCES preserve.artifact(artifact_id) ON DELETE SET NULL,
    source_segment_id      UUID                         REFERENCES preserve.segment(segment_id) ON DELETE SET NULL,
    input_sha256           TEXT,
    embedding_meta         JSONB                        NOT NULL DEFAULT '{}',
    created_run_id         UUID                         REFERENCES preserve.extraction_run(run_id),
    created_at             TIMESTAMPTZ                  NOT NULL DEFAULT now(),
    CONSTRAINT uq_embedding_index_tenant_fingerprint UNIQUE (tenant, embedding_fingerprint),
    CONSTRAINT fk_embedding_index_tenant_media FOREIGN KEY (tenant, media_artifact_id)
        REFERENCES preserve.media_artifact(tenant, media_artifact_id) ON DELETE CASCADE,
    CONSTRAINT fk_embedding_index_tenant_region FOREIGN KEY (tenant, visual_region_id)
        REFERENCES preserve.visual_region(tenant, visual_region_id) ON DELETE CASCADE,
    CONSTRAINT chk_embedding_index_target_kind CHECK (
        target_kind IN (
            'artifact',
            'segment',
            'entity',
            'fact',
            'memory',
            'media_artifact',
            'visual_region',
            'event_frame',
            'procedure'
        )
    ),
    CONSTRAINT chk_embedding_index_vector_role CHECK (
        vector_role IN ('content','title','summary','entity','image','layout','region','query','other')
    ),
    CONSTRAINT chk_embedding_index_dimension CHECK (embedding_dimension = 384),
    CONSTRAINT chk_embedding_index_distance_metric CHECK (
        distance_metric IN ('cosine','l2','inner_product')
    ),
    CONSTRAINT chk_embedding_index_one_target CHECK (
        num_nonnulls(
            artifact_id,
            segment_id,
            entity_id,
            fact_id,
            memory_id,
            media_artifact_id,
            visual_region_id,
            event_frame_id,
            procedure_id
        ) = 1
    ),
    CONSTRAINT chk_embedding_index_target_matches_kind CHECK (
        (target_kind = 'artifact' AND artifact_id IS NOT NULL)
        OR (target_kind = 'segment' AND segment_id IS NOT NULL)
        OR (target_kind = 'entity' AND entity_id IS NOT NULL)
        OR (target_kind = 'fact' AND fact_id IS NOT NULL)
        OR (target_kind = 'memory' AND memory_id IS NOT NULL)
        OR (target_kind = 'media_artifact' AND media_artifact_id IS NOT NULL)
        OR (target_kind = 'visual_region' AND visual_region_id IS NOT NULL)
        OR (target_kind = 'event_frame' AND event_frame_id IS NOT NULL)
        OR (target_kind = 'procedure' AND procedure_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_embedding_index_vector
    ON preserve.embedding_index USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_embedding_index_model_role
    ON preserve.embedding_index (tenant, embedding_model, vector_role);
CREATE INDEX IF NOT EXISTS idx_embedding_index_artifact
    ON preserve.embedding_index (tenant, artifact_id) WHERE artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_index_segment
    ON preserve.embedding_index (tenant, segment_id) WHERE segment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_index_entity
    ON preserve.embedding_index (tenant, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_index_fact
    ON preserve.embedding_index (tenant, fact_id) WHERE fact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_index_memory
    ON preserve.embedding_index (tenant, memory_id) WHERE memory_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_index_media_artifact
    ON preserve.embedding_index (tenant, media_artifact_id) WHERE media_artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_index_visual_region
    ON preserve.embedding_index (tenant, visual_region_id) WHERE visual_region_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_index_event_frame
    ON preserve.embedding_index (tenant, event_frame_id) WHERE event_frame_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_index_procedure
    ON preserve.embedding_index (tenant, procedure_id) WHERE procedure_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_embedding_index_source_artifact
    ON preserve.embedding_index (tenant, source_artifact_id);
CREATE INDEX IF NOT EXISTS idx_embedding_index_source_segment
    ON preserve.embedding_index (tenant, source_segment_id);

DROP TRIGGER IF EXISTS trg_media_artifact_updated_at ON preserve.media_artifact;
CREATE TRIGGER trg_media_artifact_updated_at
    BEFORE UPDATE ON preserve.media_artifact
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();

DROP TRIGGER IF EXISTS trg_visual_region_updated_at ON preserve.visual_region;
CREATE TRIGGER trg_visual_region_updated_at
    BEFORE UPDATE ON preserve.visual_region
    FOR EACH ROW EXECUTE FUNCTION preserve.trg_set_updated_at();
