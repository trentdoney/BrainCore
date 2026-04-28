-- Manual rollback only. BrainCore does not expose a supported rollback CLI.
-- Apply only to a tested non-production database after taking a backup.
-- This file drops data-bearing tables created by migration 016.

DROP TRIGGER IF EXISTS trg_working_memory_updated_at ON preserve.working_memory;
DROP TRIGGER IF EXISTS trg_task_session_updated_at ON preserve.task_session;

DROP TABLE IF EXISTS preserve.working_memory;
DROP TABLE IF EXISTS preserve.task_session;
