# BrainCore Upgrade Guide

This guide is for upgrades within the public BrainCore launch surface.

## Versioning

The launch release is `v1.1.4`.

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

## Breaking changes to watch

- schema count changes
- new source types
- new eval tables
- embedder behavior
- public claims that need new evidence rows

If one of those changes lands, update the docs and incident bundle in
the same change set.
