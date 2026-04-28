-- Manual rollback only. BrainCore does not expose a supported rollback CLI.
-- Apply only to a tested non-production database after taking a backup.
-- This file drops data-bearing tables created by migration 017.

DROP TRIGGER IF EXISTS trg_visual_region_updated_at ON preserve.visual_region;
DROP TRIGGER IF EXISTS trg_media_artifact_updated_at ON preserve.media_artifact;

DROP TABLE IF EXISTS preserve.embedding_index;
DROP TABLE IF EXISTS preserve.visual_region;
DROP TABLE IF EXISTS preserve.media_artifact;
