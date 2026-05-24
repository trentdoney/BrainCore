-- =============================================================================
-- BrainCore Preserve Schema - 023_assistant_memory_sources.sql
-- Adds source_type enum values for BrainCore-native assistant memory migration.
--
-- These sources are deterministic imports from external assistant-memory stores.
-- They remain non-promotable by default at artifact creation time; operator
-- review and memory governance decide prompt eligibility later.
-- =============================================================================

SET search_path TO preserve, public;

ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS 'vestige_memory';
ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS 'pai_auto_memory';

COMMENT ON TYPE preserve.source_type IS
  'Artifact source families supported by deterministic ingestion pipelines, including assistant memory migration sources.';
