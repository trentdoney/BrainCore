-- BrainCore Preserve Schema: working-memory operation support.
--
-- This migration extends working_memory so promotion candidates can point at
-- the approved durable target types without encoding those targets only in
-- JSON metadata.

SET search_path TO preserve, public;

ALTER TABLE preserve.working_memory
    ADD COLUMN IF NOT EXISTS promotion_target_kind TEXT,
    ADD COLUMN IF NOT EXISTS promotion_target_id UUID,
    ADD COLUMN IF NOT EXISTS promotion_marked_at TIMESTAMPTZ;

ALTER TABLE preserve.working_memory
    DROP CONSTRAINT IF EXISTS chk_working_memory_promoted_target;

ALTER TABLE preserve.working_memory
    ADD CONSTRAINT chk_working_memory_promotion_target_kind CHECK (
        promotion_target_kind IS NULL
        OR promotion_target_kind IN ('fact', 'event_frame', 'memory', 'procedure')
    );

ALTER TABLE preserve.working_memory
    ADD CONSTRAINT chk_working_memory_promotion_target_pair CHECK (
        (promotion_target_kind IS NULL AND promotion_target_id IS NULL)
        OR (promotion_target_kind IS NOT NULL AND promotion_target_id IS NOT NULL)
    );

ALTER TABLE preserve.working_memory
    ADD CONSTRAINT chk_working_memory_promoted_target CHECK (
        (
            promotion_status = 'promoted'
            AND (
                promoted_memory_id IS NOT NULL
                OR (
                    promotion_target_kind IS NOT NULL
                    AND promotion_target_id IS NOT NULL
                )
            )
        )
        OR (
            promotion_status <> 'promoted'
            AND promoted_memory_id IS NULL
        )
    );

CREATE INDEX IF NOT EXISTS idx_working_memory_promotion_target
    ON preserve.working_memory (tenant, promotion_target_kind, promotion_target_id)
    WHERE promotion_target_kind IS NOT NULL;
