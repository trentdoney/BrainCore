-- =============================================================================
-- BrainCore Preserve Schema  —  006_source_type_values.sql
-- Adds source_type enum values that src/cli.ts inserts but 001 didn't define.
-- Idempotent: ALTER TYPE ... ADD VALUE IF NOT EXISTS is safe to re-run.
-- Transaction model: BrainCore has no migration runner. SETUP.md directs users
-- to invoke `psql "$BRAINCORE_POSTGRES_DSN" -f sql/006_source_type_values.sql`
-- directly. Plain `psql -f` auto-commits each statement (no implicit wrap),
-- so plain `ALTER TYPE ... ADD VALUE IF NOT EXISTS` is safe here. Users who
-- opt into `psql -1` (single-transaction mode) should run this file by itself
-- because `ALTER TYPE ... ADD VALUE` cannot share a transaction with an
-- `INSERT` that uses the new value on Postgres 12+.
-- =============================================================================

SET search_path TO preserve, public;

ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS 'codex_session';
ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS 'codex_shared';
ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS 'discord_conversation';
ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS 'telegram_chat';
ALTER TYPE preserve.source_type ADD VALUE IF NOT EXISTS 'monitoring_alert';
