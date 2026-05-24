-- =============================================================================
-- BrainCore Preserve Schema - 024_project_doc_sources.sql
-- Adds source_type enum value for curated project documentation ingestion.
--
-- Project documentation artifacts are non-promotable by default. Operators must
-- approve a value-review decision before any project-doc content becomes
-- prompt-eligible memory.
-- =============================================================================

SET search_path TO preserve, public;

ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS 'project_doc';

COMMENT ON TYPE preserve.source_type IS
  'Artifact source families supported by deterministic ingestion pipelines, including curated project documentation.';
