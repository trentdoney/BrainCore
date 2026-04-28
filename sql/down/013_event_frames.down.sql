-- Manual rollback only. BrainCore does not expose a supported rollback CLI.
-- Apply only to a tested non-production database after taking a backup.
-- This file drops data-bearing tables created by migration 013.

DROP TRIGGER IF EXISTS trg_event_frame_updated_at ON preserve.event_frame;
DROP TABLE IF EXISTS preserve.event_frame;
