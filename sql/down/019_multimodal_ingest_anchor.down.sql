-- Manual rollback only: drops multimodal ingest batch anchors added by 019.

DROP INDEX IF EXISTS preserve.idx_visual_region_ingest_batch;
DROP INDEX IF EXISTS preserve.idx_visual_region_ingest_run;
DROP INDEX IF EXISTS preserve.idx_media_artifact_ingest_batch;
DROP INDEX IF EXISTS preserve.idx_media_artifact_ingest_run;

ALTER TABLE IF EXISTS preserve.visual_region
  DROP COLUMN IF EXISTS ingest_batch_key,
  DROP COLUMN IF EXISTS ingest_run_id;

ALTER TABLE IF EXISTS preserve.media_artifact
  DROP COLUMN IF EXISTS ingest_batch_key,
  DROP COLUMN IF EXISTS ingest_run_id;
