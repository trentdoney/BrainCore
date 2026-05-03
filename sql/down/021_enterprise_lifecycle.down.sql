-- Roll back BrainCore enterprise lifecycle layer.
-- This drops only objects introduced by 021_enterprise_lifecycle.sql.

SET search_path TO preserve, public;

DROP TRIGGER IF EXISTS trg_lifecycle_cue_updated_at ON preserve.lifecycle_cue;
DROP TRIGGER IF EXISTS trg_lifecycle_intelligence_updated_at ON preserve.lifecycle_target_intelligence;
DROP TRIGGER IF EXISTS trg_lifecycle_audit_log_append_only ON preserve.lifecycle_audit_log;
DROP TRIGGER IF EXISTS trg_lifecycle_score_audit_append_only ON preserve.lifecycle_score_audit;
DROP TRIGGER IF EXISTS trg_lifecycle_feedback_append_only ON preserve.lifecycle_feedback_event;

DROP TABLE IF EXISTS preserve.lifecycle_audit_log;
DROP TABLE IF EXISTS preserve.lifecycle_score_audit;
DROP TABLE IF EXISTS preserve.lifecycle_feedback_event;
DROP TABLE IF EXISTS preserve.context_recall_audit;
DROP TABLE IF EXISTS preserve.lifecycle_cue;
DROP TABLE IF EXISTS preserve.lifecycle_target_intelligence;
DROP TABLE IF EXISTS preserve.lifecycle_outbox;

DROP FUNCTION IF EXISTS preserve.reject_lifecycle_append_only_mutation();

DELETE FROM preserve.schema_migration
WHERE migration_name = '021_enterprise_lifecycle.sql';
