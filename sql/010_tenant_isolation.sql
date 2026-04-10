-- =============================================================================
-- BrainCore Preserve Schema  —  010_tenant_isolation.sql
-- Repairs tenant-blind entity/memory identity and promotes tenant-scoped
-- uniqueness for artifacts, entities, and derived memories.
-- =============================================================================

SET search_path TO preserve, public;

BEGIN;

LOCK TABLE preserve.entity,
           preserve.project_service_map,
           preserve.artifact,
           preserve.segment,
           preserve.extraction_run,
           preserve.episode,
           preserve.event,
           preserve.fact,
           preserve.memory,
           preserve.memory_support
IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- Preflight: infer tenants for support and event rows before any rewrites.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _support_tenants ON COMMIT DROP AS
SELECT
    ms.support_id,
    ms.memory_id AS old_memory_id,
    CASE
        WHEN f.tenant IS NOT NULL
         AND ep.tenant IS NOT NULL
         AND f.tenant <> ep.tenant THEN NULL
        ELSE COALESCE(f.tenant, ep.tenant)
    END AS target_tenant
FROM preserve.memory_support ms
LEFT JOIN preserve.fact f
  ON f.fact_id = ms.fact_id
LEFT JOIN preserve.episode ep
  ON ep.episode_id = ms.episode_id;

DO $$
DECLARE
    ambiguous_support_count integer;
BEGIN
    SELECT count(*) INTO ambiguous_support_count
    FROM _support_tenants
    WHERE target_tenant IS NULL;

    IF ambiguous_support_count > 0 THEN
        RAISE EXCEPTION
            '010_tenant_isolation: % memory_support rows have ambiguous tenant inference',
            ambiguous_support_count;
    END IF;
END $$;

CREATE TEMP TABLE _memory_targets ON COMMIT DROP AS
SELECT DISTINCT m.memory_id AS old_memory_id, st.target_tenant
FROM preserve.memory m
JOIN _support_tenants st
  ON st.old_memory_id = m.memory_id
UNION
SELECT memory_id AS old_memory_id, tenant AS target_tenant
FROM preserve.memory;

CREATE TEMP TABLE _event_tenant_candidates ON COMMIT DROP AS
SELECT ev.event_id, ev.entity_id AS old_entity_id, ep.tenant
FROM preserve.event ev
JOIN preserve.episode ep ON ep.episode_id = ev.episode_id
WHERE ev.entity_id IS NOT NULL
  AND ep.tenant IS NOT NULL
UNION ALL
SELECT ev.event_id, ev.entity_id AS old_entity_id, sg.tenant
FROM preserve.event ev
JOIN preserve.segment sg ON sg.segment_id = ev.segment_id
WHERE ev.entity_id IS NOT NULL
  AND sg.tenant IS NOT NULL
UNION ALL
SELECT ev.event_id, ev.entity_id AS old_entity_id, a.tenant
FROM preserve.event ev
JOIN preserve.extraction_run er ON er.run_id = ev.created_run_id
JOIN preserve.artifact a ON a.artifact_id = er.artifact_id
WHERE ev.entity_id IS NOT NULL
  AND a.tenant IS NOT NULL;

CREATE TEMP TABLE _event_tenants ON COMMIT DROP AS
SELECT
    event_id,
    old_entity_id,
    array_agg(DISTINCT tenant ORDER BY tenant) AS tenants
FROM _event_tenant_candidates
GROUP BY event_id, old_entity_id;

DO $$
DECLARE
    ambiguous_event_count integer;
BEGIN
    SELECT count(*) INTO ambiguous_event_count
    FROM _event_tenants
    WHERE COALESCE(array_length(tenants, 1), 0) <> 1;

    IF ambiguous_event_count > 0 THEN
        RAISE EXCEPTION
            '010_tenant_isolation: % event rows have ambiguous tenant inference',
            ambiguous_event_count;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Drop the old global uniqueness rules before inserting tenant-local copies.
-- ---------------------------------------------------------------------------

ALTER TABLE preserve.artifact DROP CONSTRAINT IF EXISTS artifact_source_key_key;
ALTER TABLE preserve.artifact DROP CONSTRAINT IF EXISTS uq_artifact_tenant_source_key;

ALTER TABLE preserve.entity DROP CONSTRAINT IF EXISTS entity_entity_type_canonical_name_key;
ALTER TABLE preserve.entity DROP CONSTRAINT IF EXISTS uq_entity_tenant_type_name;

ALTER TABLE preserve.memory DROP CONSTRAINT IF EXISTS memory_fingerprint_key;
ALTER TABLE preserve.memory DROP CONSTRAINT IF EXISTS uq_memory_tenant_fingerprint;

-- ---------------------------------------------------------------------------
-- Entity repair.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _entity_targets (
    old_entity_id UUID NOT NULL,
    target_tenant TEXT NOT NULL,
    PRIMARY KEY (old_entity_id, target_tenant)
) ON COMMIT DROP;

INSERT INTO _entity_targets (old_entity_id, target_tenant)
SELECT DISTINCT old_entity_id, target_tenant
FROM (
    SELECT entity_id AS old_entity_id, tenant AS target_tenant
    FROM preserve.entity

    UNION ALL

    SELECT subject_entity_id, tenant
    FROM preserve.fact
    WHERE subject_entity_id IS NOT NULL

    UNION ALL

    SELECT object_entity_id, tenant
    FROM preserve.fact
    WHERE object_entity_id IS NOT NULL

    UNION ALL

    SELECT project_entity_id, tenant
    FROM preserve.artifact
    WHERE project_entity_id IS NOT NULL

    UNION ALL

    SELECT project_entity_id, tenant
    FROM preserve.fact
    WHERE project_entity_id IS NOT NULL

    UNION ALL

    SELECT project_entity_id, tenant
    FROM preserve.segment
    WHERE project_entity_id IS NOT NULL

    UNION ALL

    SELECT project_entity_id, tenant
    FROM preserve.episode
    WHERE project_entity_id IS NOT NULL

    UNION ALL

    SELECT scope_entity_id, mt.target_tenant
    FROM preserve.memory m
    JOIN _memory_targets mt ON mt.old_memory_id = m.memory_id
    WHERE m.scope_entity_id IS NOT NULL

    UNION ALL

    SELECT project_entity_id, mt.target_tenant
    FROM preserve.memory m
    JOIN _memory_targets mt ON mt.old_memory_id = m.memory_id
    WHERE m.project_entity_id IS NOT NULL

    UNION ALL

    SELECT old_entity_id, tenants[1]
    FROM _event_tenants
) refs
WHERE old_entity_id IS NOT NULL
  AND target_tenant IS NOT NULL;

CREATE TEMP TABLE _entity_remap (
    old_entity_id UUID NOT NULL,
    target_tenant TEXT NOT NULL,
    new_entity_id UUID NOT NULL,
    PRIMARY KEY (old_entity_id, target_tenant)
) ON COMMIT DROP;

INSERT INTO _entity_remap (old_entity_id, target_tenant, new_entity_id)
SELECT
    t.old_entity_id,
    t.target_tenant,
    e.entity_id
FROM _entity_targets t
JOIN preserve.entity src ON src.entity_id = t.old_entity_id
JOIN preserve.entity e
  ON e.tenant = t.target_tenant
 AND e.entity_type = src.entity_type
 AND e.canonical_name = src.canonical_name;

INSERT INTO preserve.entity (
    tenant,
    entity_type,
    canonical_name,
    aliases,
    attrs,
    first_seen_at,
    last_seen_at,
    embedding
)
SELECT
    t.target_tenant,
    src.entity_type,
    src.canonical_name,
    src.aliases,
    CASE
        WHEN src.entity_type = 'project'::preserve.entity_type THEN
            COALESCE(src.attrs, '{}'::jsonb)
                - 'status'
                - 'archived_at'
                - 'archive_reason'
                - 'forked_from'
                - 'forked_at'
                - 'merged_into'
                - 'merged_at'
        ELSE src.attrs
    END,
    src.first_seen_at,
    src.last_seen_at,
    src.embedding
FROM _entity_targets t
JOIN preserve.entity src ON src.entity_id = t.old_entity_id
LEFT JOIN _entity_remap r
  ON r.old_entity_id = t.old_entity_id
 AND r.target_tenant = t.target_tenant
WHERE r.old_entity_id IS NULL;

INSERT INTO _entity_remap (old_entity_id, target_tenant, new_entity_id)
SELECT
    t.old_entity_id,
    t.target_tenant,
    e.entity_id
FROM _entity_targets t
JOIN preserve.entity src ON src.entity_id = t.old_entity_id
JOIN preserve.entity e
  ON e.tenant = t.target_tenant
 AND e.entity_type = src.entity_type
 AND e.canonical_name = src.canonical_name
LEFT JOIN _entity_remap r
  ON r.old_entity_id = t.old_entity_id
 AND r.target_tenant = t.target_tenant
WHERE r.old_entity_id IS NULL;

UPDATE preserve.fact f
SET subject_entity_id = r.new_entity_id
FROM _entity_remap r
WHERE f.subject_entity_id = r.old_entity_id
  AND f.tenant = r.target_tenant
  AND f.subject_entity_id <> r.new_entity_id;

UPDATE preserve.fact f
SET object_entity_id = r.new_entity_id
FROM _entity_remap r
WHERE f.object_entity_id = r.old_entity_id
  AND f.tenant = r.target_tenant
  AND f.object_entity_id <> r.new_entity_id;

UPDATE preserve.artifact a
SET project_entity_id = r.new_entity_id
FROM _entity_remap r
WHERE a.project_entity_id = r.old_entity_id
  AND a.tenant = r.target_tenant
  AND a.project_entity_id <> r.new_entity_id;

UPDATE preserve.fact f
SET project_entity_id = r.new_entity_id
FROM _entity_remap r
WHERE f.project_entity_id = r.old_entity_id
  AND f.tenant = r.target_tenant
  AND f.project_entity_id <> r.new_entity_id;

UPDATE preserve.segment s
SET project_entity_id = r.new_entity_id
FROM _entity_remap r
WHERE s.project_entity_id = r.old_entity_id
  AND s.tenant = r.target_tenant
  AND s.project_entity_id <> r.new_entity_id;

UPDATE preserve.episode ep
SET project_entity_id = r.new_entity_id
FROM _entity_remap r
WHERE ep.project_entity_id = r.old_entity_id
  AND ep.tenant = r.target_tenant
  AND ep.project_entity_id <> r.new_entity_id;

UPDATE preserve.memory m
SET scope_entity_id = r.new_entity_id
FROM _entity_remap r
WHERE m.scope_entity_id = r.old_entity_id
  AND m.tenant = r.target_tenant
  AND m.scope_entity_id <> r.new_entity_id;

UPDATE preserve.memory m
SET project_entity_id = r.new_entity_id
FROM _entity_remap r
WHERE m.project_entity_id = r.old_entity_id
  AND m.tenant = r.target_tenant
  AND m.project_entity_id <> r.new_entity_id;

UPDATE preserve.event ev
SET entity_id = r.new_entity_id
FROM _event_tenants et
JOIN _entity_remap r
  ON r.old_entity_id = et.old_entity_id
 AND r.target_tenant = et.tenants[1]
WHERE ev.event_id = et.event_id
  AND ev.entity_id <> r.new_entity_id;

INSERT INTO preserve.project_service_map (project_entity_id, service_name)
SELECT DISTINCT
    r.new_entity_id,
    psm.service_name
FROM preserve.project_service_map psm
JOIN preserve.entity src
  ON src.entity_id = psm.project_entity_id
 AND src.entity_type = 'project'::preserve.entity_type
JOIN _entity_remap r
  ON r.old_entity_id = psm.project_entity_id
ON CONFLICT (project_entity_id, service_name) DO NOTHING;

DELETE FROM preserve.entity e
WHERE EXISTS (
        SELECT 1
        FROM _entity_targets t
        WHERE t.old_entity_id = e.entity_id
          AND t.target_tenant <> e.tenant
    )
  AND NOT EXISTS (SELECT 1 FROM preserve.fact f WHERE f.subject_entity_id = e.entity_id)
  AND NOT EXISTS (SELECT 1 FROM preserve.fact f WHERE f.object_entity_id = e.entity_id)
  AND NOT EXISTS (SELECT 1 FROM preserve.artifact a WHERE a.project_entity_id = e.entity_id)
  AND NOT EXISTS (SELECT 1 FROM preserve.fact f WHERE f.project_entity_id = e.entity_id)
  AND NOT EXISTS (SELECT 1 FROM preserve.segment s WHERE s.project_entity_id = e.entity_id)
  AND NOT EXISTS (SELECT 1 FROM preserve.episode ep WHERE ep.project_entity_id = e.entity_id)
  AND NOT EXISTS (SELECT 1 FROM preserve.memory m WHERE m.scope_entity_id = e.entity_id)
  AND NOT EXISTS (SELECT 1 FROM preserve.memory m WHERE m.project_entity_id = e.entity_id)
  AND NOT EXISTS (SELECT 1 FROM preserve.event ev WHERE ev.entity_id = e.entity_id)
  AND NOT EXISTS (SELECT 1 FROM preserve.project_service_map psm WHERE psm.project_entity_id = e.entity_id);

-- ---------------------------------------------------------------------------
-- Memory repair.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _memory_remap (
    old_memory_id UUID NOT NULL,
    target_tenant TEXT NOT NULL,
    new_memory_id UUID NOT NULL,
    PRIMARY KEY (old_memory_id, target_tenant)
) ON COMMIT DROP;

INSERT INTO _memory_remap (old_memory_id, target_tenant, new_memory_id)
SELECT
    mt.old_memory_id,
    mt.target_tenant,
    src.memory_id
FROM _memory_targets mt
JOIN preserve.memory src ON src.memory_id = mt.old_memory_id
WHERE src.tenant = mt.target_tenant;

INSERT INTO _memory_remap (old_memory_id, target_tenant, new_memory_id)
SELECT
    mt.old_memory_id,
    mt.target_tenant,
    existing.memory_id
FROM _memory_targets mt
JOIN preserve.memory src ON src.memory_id = mt.old_memory_id
JOIN preserve.memory existing
  ON existing.tenant = mt.target_tenant
 AND existing.fingerprint IS NOT DISTINCT FROM src.fingerprint
LEFT JOIN _memory_remap r
  ON r.old_memory_id = mt.old_memory_id
 AND r.target_tenant = mt.target_tenant
WHERE r.old_memory_id IS NULL;

INSERT INTO preserve.memory (
    memory_type,
    scope_entity_id,
    project_entity_id,
    tenant,
    fingerprint,
    title,
    narrative,
    support_count,
    contradiction_count,
    confidence,
    valid_from,
    valid_to,
    lifecycle_state,
    pipeline_version,
    model_name,
    prompt_version,
    scope_path,
    priority,
    last_supported_at,
    embedding,
    created_at,
    updated_at
)
SELECT
    src.memory_type,
    COALESCE(scope_map.new_entity_id, src.scope_entity_id),
    COALESCE(project_map.new_entity_id, src.project_entity_id),
    mt.target_tenant,
    src.fingerprint,
    src.title,
    src.narrative,
    src.support_count,
    src.contradiction_count,
    src.confidence,
    src.valid_from,
    src.valid_to,
    src.lifecycle_state,
    src.pipeline_version,
    src.model_name,
    src.prompt_version,
    src.scope_path,
    src.priority,
    src.last_supported_at,
    src.embedding,
    src.created_at,
    src.updated_at
FROM _memory_targets mt
JOIN preserve.memory src ON src.memory_id = mt.old_memory_id
LEFT JOIN _memory_remap r
  ON r.old_memory_id = mt.old_memory_id
 AND r.target_tenant = mt.target_tenant
LEFT JOIN _entity_remap scope_map
  ON scope_map.old_entity_id = src.scope_entity_id
 AND scope_map.target_tenant = mt.target_tenant
LEFT JOIN _entity_remap project_map
  ON project_map.old_entity_id = src.project_entity_id
 AND project_map.target_tenant = mt.target_tenant
WHERE r.old_memory_id IS NULL;

INSERT INTO _memory_remap (old_memory_id, target_tenant, new_memory_id)
SELECT
    mt.old_memory_id,
    mt.target_tenant,
    existing.memory_id
FROM _memory_targets mt
JOIN preserve.memory src ON src.memory_id = mt.old_memory_id
JOIN preserve.memory existing
  ON existing.tenant = mt.target_tenant
 AND existing.fingerprint IS NOT DISTINCT FROM src.fingerprint
LEFT JOIN _memory_remap r
  ON r.old_memory_id = mt.old_memory_id
 AND r.target_tenant = mt.target_tenant
WHERE r.old_memory_id IS NULL;

UPDATE preserve.memory_support ms
SET memory_id = mr.new_memory_id
FROM _support_tenants st
JOIN _memory_remap mr
  ON mr.old_memory_id = st.old_memory_id
 AND mr.target_tenant = st.target_tenant
WHERE ms.support_id = st.support_id
  AND ms.memory_id <> mr.new_memory_id;

DELETE FROM preserve.memory m
WHERE EXISTS (
        SELECT 1
        FROM _memory_targets mt
        WHERE mt.old_memory_id = m.memory_id
          AND mt.target_tenant <> m.tenant
    )
  AND NOT EXISTS (
        SELECT 1
        FROM preserve.memory_support ms
        WHERE ms.memory_id = m.memory_id
    );

-- ---------------------------------------------------------------------------
-- Enforce tenant-scoped identity.
-- ---------------------------------------------------------------------------

ALTER TABLE preserve.artifact
    ADD CONSTRAINT uq_artifact_tenant_source_key UNIQUE (tenant, source_key);

ALTER TABLE preserve.entity
    ADD CONSTRAINT uq_entity_tenant_type_name UNIQUE (tenant, entity_type, canonical_name);

ALTER TABLE preserve.memory
    ADD CONSTRAINT uq_memory_tenant_fingerprint UNIQUE (tenant, fingerprint);

COMMIT;
