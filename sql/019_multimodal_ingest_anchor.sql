-- BrainCore Preserve Schema: multimodal ingest batch anchors.
--
-- This migration adds rollback-friendly batch identifiers before any live
-- media or visual-region ingest jobs run.

ALTER TABLE preserve.media_artifact
  ADD COLUMN IF NOT EXISTS ingest_run_id UUID,
  ADD COLUMN IF NOT EXISTS ingest_batch_key TEXT;

ALTER TABLE preserve.visual_region
  ADD COLUMN IF NOT EXISTS ingest_run_id UUID,
  ADD COLUMN IF NOT EXISTS ingest_batch_key TEXT;

CREATE INDEX IF NOT EXISTS idx_media_artifact_ingest_run
  ON preserve.media_artifact (tenant, ingest_run_id)
  WHERE ingest_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_artifact_ingest_batch
  ON preserve.media_artifact (tenant, ingest_batch_key)
  WHERE ingest_batch_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_visual_region_ingest_run
  ON preserve.visual_region (tenant, ingest_run_id)
  WHERE ingest_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_visual_region_ingest_batch
  ON preserve.visual_region (tenant, ingest_batch_key)
  WHERE ingest_batch_key IS NOT NULL;
