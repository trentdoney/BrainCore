-- =============================================================================
-- BrainCore Preserve Schema  —  008_eval_case.sql
-- Creates preserve.eval_case — the gold-set table that
-- src/eval/gold.ts:loadGoldSet SELECTs from and src/eval/runner.ts iterates
-- over, but no prior migration created.
--
-- Schema derivation (every column traceable to src/eval/gold.ts +
-- src/eval/runner.ts + src/eval/types.ts):
--   - eval_case_id   gold.ts:13 (SELECT ec.eval_case_id), gold.ts:19,
--                    runner.ts:34, types.ts:19. Primary key — UUID with
--                    default gen_random_uuid() to mirror eval_run (007).
--   - artifact_id    gold.ts:13 (SELECT ec.artifact_id), gold.ts:20,
--                    runner.ts:27 (cast `${evalCase.artifact_id}::uuid` then
--                    queried against preserve.artifact.artifact_id), and
--                    runner.ts:30 (passed to compareExtraction which casts
--                    ::uuid in 4 join queries gold.ts:38/52/61). UUID, FK to
--                    preserve.artifact(artifact_id) with ON DELETE CASCADE
--                    so dropped artifacts also drop their gold cases.
--   - gold_labels    gold.ts:13 (SELECT ec.gold_labels), gold.ts:21
--                    (`r.gold_labels as GoldLabels`), types.ts:5-16
--                    (GoldLabels interface — entities array, root_cause,
--                    fix_summary, services, fact_count_expected,
--                    has_semantic_content, complexity, device, det_count,
--                    semantic_count). JSONB, NOT NULL — every read site
--                    dereferences fields without null guards
--                    (runner.ts:37-40 reads .device and .complexity).
--   - notes          gold.ts:13 (SELECT ec.notes), gold.ts:22, types.ts:23
--                    (`notes: string | null`). TEXT, NULLABLE — explicitly
--                    typed as nullable in the EvalCase interface.
--   - source_type    gold.ts:13 (SELECT ec.source_type), gold.ts:23,
--                    types.ts:24 (`source_type: string`). Reuses the
--                    existing preserve.source_type enum from migration
--                    001 (extended by 006) so eval cases stay consistent
--                    with the artifact taxonomy. NOT NULL.
--   - created_at     gold.ts:13 (SELECT ec.created_at), gold.ts:15
--                    (`ORDER BY ec.created_at ASC`), gold.ts:24,
--                    types.ts:25 (`created_at: Date`). TIMESTAMPTZ NOT
--                    NULL DEFAULT now(); ORDER BY clause implies an
--                    ascending index for cheap ordered loads.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- `bun src/cli.ts eval --run` no longer crashes on a fresh clone with
-- `relation "preserve.eval_case" does not exist`.
-- =============================================================================

SET search_path TO preserve, public;

CREATE TABLE IF NOT EXISTS preserve.eval_case (
    eval_case_id UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id  UUID                  NOT NULL
        REFERENCES preserve.artifact (artifact_id) ON DELETE CASCADE,
    gold_labels  JSONB                 NOT NULL,
    notes        TEXT,
    source_type  preserve.source_type  NOT NULL,
    created_at   TIMESTAMPTZ           NOT NULL DEFAULT now()
);

-- gold.ts:15 ORDER BY ec.created_at ASC — ascending index keeps loadGoldSet
-- linear in the number of cases.
CREATE INDEX IF NOT EXISTS idx_eval_case_created_at
    ON preserve.eval_case (created_at ASC);

-- compareExtraction joins through artifact_id in 3 separate queries
-- (gold.ts:38, gold.ts:52, gold.ts:61); a btree index on the FK column
-- keeps per-case lookups cheap once the gold set grows.
CREATE INDEX IF NOT EXISTS idx_eval_case_artifact_id
    ON preserve.eval_case (artifact_id);
