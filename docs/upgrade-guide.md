# BrainCore Upgrade Guide

This guide is for upgrades within the public BrainCore launch surface.

## Versioning

The launch release is `v1.1.6`.

Use a patch release when you:

- fix a launch blocker
- add a migration that closes a documented fresh-install gap
- change public docs to match shipped behavior

Use a minor or major release only when the shipped surface changes in a
way that should not be described as a patch.

## Before upgrading

1. Read `README.md`, `ARCHITECTURE.md`, and `benchmarks/README.md`.
2. Check whether the change affects smoke or production benchmark
   framing.
3. Check whether the migration path changes.
4. Run `bash scripts/pre-push-gate.sh`.

## Upgrade order

When a release includes schema changes, apply them in filename order.

```bash
bun src/cli.ts migrate
```

If the command fails, fix the command or the migration set rather than
teaching readers a fallback path.

## After upgrading

Run the launch checks that matter for the changed area:

- imports for the example server
- migration tests
- claims-to-evidence self-test
- sanitization gate

If the upgrade changes benchmark numbers, update the committed JSON
artifacts and keep the smoke/production framing separate.

## Enterprise lifecycle migration 021

Migration `021_enterprise_lifecycle.sql` is additive. It creates lifecycle
outbox, intelligence, cue, context recall audit, feedback, score audit, and
audit log tables without changing BrainCore native truth rows.

Before applying on a live deployment:

1. Confirm `BRAINCORE_POSTGRES_DSN` points at the intended database.
2. Run `bun src/cli.ts migrate` on a disposable clone of the database first.
3. Verify `braincore lifecycle stats` returns outbox and intelligence counts.
4. Backfill intelligence with `braincore lifecycle backfill-intelligence`.
5. Keep lifecycle status in shadow/admin mode until retrieval suppression tests
   pass for the deployment corpus.

Rollback policy:

- Development/test rollback may use `sql/down/021_enterprise_lifecycle.down.sql`.
- Live rollback must export `lifecycle_outbox`, `lifecycle_feedback_event`,
  `lifecycle_score_audit`, `lifecycle_audit_log`, and
  `context_recall_audit` first. The down migration drops those tables.
- Do not run the down migration as an incident response unless audit/outbox data
  loss is explicitly accepted and documented.

## OpenAOS lifecycle parity map

BrainCore tracks different and additional objects than OpenAOS. The mapping is
therefore an overlay, not a table-for-table clone.

| OpenAOS lifecycle area | BrainCore target/surface | Status |
|---|---|---|
| Mission/session/tool/model events | `lifecycle_outbox.event_type` mission/session/tool/model values | Implemented as idempotent event intake |
| Memory retrieve/inject/omit feedback | `context_recall_audit` plus `lifecycle_feedback_event` | Implemented for audit and scoring |
| Memory promotion/suppression/retirement | `lifecycle_target_intelligence.lifecycle_status` | Implemented as overlay, native truth unchanged |
| Recall cues | `lifecycle_cue` | Implemented as target-bound cue metadata |
| Score/audit history | `lifecycle_score_audit`, `lifecycle_audit_log` | Implemented append-only |
| Browser/admin dashboard | Future web app upgrade path | Deferred intentionally |
| OpenAOS-only runtime internals | `lifecycle_outbox.payload`/`metadata` where useful | Mapped only when BrainCore has an equivalent target |

## Breaking changes to watch

- schema count changes
- new source types
- new eval tables
- embedder behavior
- public claims that need new evidence rows

If one of those changes lands, update the docs and benchmark evidence
in the same change set.
