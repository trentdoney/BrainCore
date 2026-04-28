-- Manual rollback only. BrainCore does not expose a supported rollback CLI.
-- Apply only to a tested non-production database after taking a backup.
-- This file drops data-bearing tables created by migration 012.

DROP TABLE IF EXISTS preserve.memory_revision_support;
DROP TABLE IF EXISTS preserve.memory_revision;
DROP TABLE IF EXISTS preserve.memory_edge_evidence;
DROP TABLE IF EXISTS preserve.memory_edge;
