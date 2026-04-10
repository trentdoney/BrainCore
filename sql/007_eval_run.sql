-- =============================================================================
-- BrainCore Preserve Schema  —  007_eval_run.sql
-- Creates preserve.eval_run — the table that src/cli.ts queries (lines 297-310)
-- and src/eval/runner.ts inserts into (lines 219-244) but no prior migration
-- created. Fixes launch blocker BL-3.
--
-- Schema derivation:
--   - eval_run_id      cli.ts:297 (SELECT), runner.ts:243 (RETURNING)
--   - pipeline_version cli.ts:297, runner.ts:225 ('0.1.0')
--   - model_name       cli.ts:297, runner.ts:226 ('deterministic+semantic')
--   - prompt_version   cli.ts:297, runner.ts:227 ('incident-v1')
--   - results          cli.ts:297-298, runner.ts:228-234 (JSONB case array)
--   - metrics          cli.ts:297-298, runner.ts:235 (JSONB AggregateMetrics)
--   - created_at       cli.ts:298, cli.ts:301 (ORDER BY created_at DESC)
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- =============================================================================

SET search_path TO preserve, public;

CREATE TABLE IF NOT EXISTS preserve.eval_run (
    eval_run_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_version TEXT        NOT NULL,
    model_name       TEXT        NOT NULL,
    prompt_version   TEXT        NOT NULL,
    results          JSONB       NOT NULL,
    metrics          JSONB       NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eval_run_created_at
    ON preserve.eval_run (created_at DESC);
