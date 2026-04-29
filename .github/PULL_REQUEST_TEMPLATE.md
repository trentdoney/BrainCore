## What changed

- [ ] I kept the change scoped to the requested files.
- [ ] I did not introduce secrets, private paths, or private hostnames.
- [ ] I ran `bash scripts/pre-push-gate.sh`.
- [ ] I ran the relevant tests or explained why I could not.
- [ ] I checked open PR comments/review threads and resolved or documented each item.

## If this touched migrations or schema

- [ ] I updated `sql/` and the matching tests.
- [ ] I verified the migration path on a clean database.
- [ ] I confirmed the preserve table count matches the current launch truth.

## If this touched docs or claims

- [ ] I updated the claims manifest or explained why no numeric claims changed.
- [ ] I kept public-facing wording honest about smoke vs production artifacts.
- [ ] I checked that the docs are dead-link-free.

## Notes

Summarize the important behavior change, verification, and any remaining
risk.
