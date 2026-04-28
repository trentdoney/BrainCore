-- Manual rollback only. BrainCore does not expose a supported rollback CLI.
-- Apply only to a tested non-production database after taking a backup.
-- This file removes promotion-target support added by migration 018.

ALTER TABLE preserve.working_memory
    DROP CONSTRAINT IF EXISTS chk_working_memory_promoted_target;

DROP INDEX IF EXISTS preserve.idx_working_memory_promotion_target;

ALTER TABLE preserve.working_memory
    DROP CONSTRAINT IF EXISTS chk_working_memory_promotion_target_pair;

ALTER TABLE preserve.working_memory
    DROP CONSTRAINT IF EXISTS chk_working_memory_promotion_target_kind;

ALTER TABLE preserve.working_memory
    ADD CONSTRAINT chk_working_memory_promoted_target CHECK (
        (promotion_status = 'promoted' AND promoted_memory_id IS NOT NULL)
        OR (promotion_status <> 'promoted' AND promoted_memory_id IS NULL)
    );

ALTER TABLE preserve.working_memory
    DROP COLUMN IF EXISTS promotion_marked_at,
    DROP COLUMN IF EXISTS promotion_target_id,
    DROP COLUMN IF EXISTS promotion_target_kind;
