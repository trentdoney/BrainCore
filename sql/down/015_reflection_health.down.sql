-- Manual rollback only. BrainCore does not expose a supported rollback CLI.
-- Apply only to a tested non-production database after taking a backup.
-- This file drops data-bearing tables created by migration 015.

DROP TRIGGER IF EXISTS trg_memory_health_updated_at ON preserve.memory_health;
DROP TRIGGER IF EXISTS trg_rule_updated_at ON preserve.rule;
DROP TRIGGER IF EXISTS trg_belief_updated_at ON preserve.belief;
DROP TRIGGER IF EXISTS trg_entity_summary_updated_at ON preserve.entity_summary;
DROP TRIGGER IF EXISTS trg_reflection_class_updated_at ON preserve.reflection_class;

DROP TABLE IF EXISTS preserve.memory_health_evidence;
DROP TABLE IF EXISTS preserve.memory_health;
DROP TABLE IF EXISTS preserve.memory_usage;
DROP TABLE IF EXISTS preserve.rule_evidence;
DROP TABLE IF EXISTS preserve.rule;
DROP TABLE IF EXISTS preserve.belief_evidence;
DROP TABLE IF EXISTS preserve.belief;
DROP TABLE IF EXISTS preserve.entity_summary_evidence;
DROP TABLE IF EXISTS preserve.entity_summary;
DROP TABLE IF EXISTS preserve.reflection_class;
