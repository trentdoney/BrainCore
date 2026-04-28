-- Manual rollback only. BrainCore does not expose a supported rollback CLI.
-- Apply only to a tested non-production database after taking a backup.
-- This file drops data-bearing tables created by migration 014.

DROP TRIGGER IF EXISTS trg_procedure_updated_at ON preserve.procedure;
DROP TABLE IF EXISTS preserve.procedure_step;
DROP TABLE IF EXISTS preserve.procedure;
