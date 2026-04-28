-- =============================================================================
-- BrainCore Preserve Schema  —  011_source_integrations.sql
-- Adds source_type enum values for deterministic source ingestion.
--
-- Keep this migration separate from 006 so installed databases with a migration
-- ledger do not see a checksum change on an already-applied file.
-- =============================================================================

SET search_path TO preserve, public;

ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS 'asana_task';
ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS 'git_commit';

COMMENT ON TYPE preserve.source_type IS
  'Artifact source families supported by deterministic ingestion pipelines.';
