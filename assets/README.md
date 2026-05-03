# BrainCore launch assets

The current BrainCore visuals are committed in this repository. Files marked
`Active` are used by the README or GitHub presentation layer in this branch.
Historical image files may remain in the directory, but only manifest-listed
active assets should be referenced by public docs.

| File | Status | Dimensions | Format | Usage |
|---|---|---|---|---|
| `og.png` | Active | 1672 by 941 | PNG | README hero block and social preview source |
| `lifecycle-control-flow.png` | Active | 1672 by 941 | PNG | README lifecycle control flow overview |
| `maintained-by-trent.jpg` | Active | 1200 by 397 | JPEG | README author note banner |
| `manifest.json` | Reference | n/a | JSON | Hash and dimension manifest |
| `README.md` | Reference | n/a | Markdown | Asset notes |

## Image Asset Ownership

Image assets are human-owned release materials. Agents must not create,
regenerate, replace, compress, optimize, or overwrite image files in this
repository. If a visual refresh is needed, agents may identify the need and
provide prompt text only in chat or private planning notes. The human owner must
create, review, approve, and supply the final asset before it can be committed.

Any unexpected image binary diff is a public-release blocker. Do not commit
generated prompts, draft image instructions, hostnames, IP addresses, internal
paths, private project names, tokens, or deployment-only metadata into this
public repository.

Run `python scripts/verify-readme-assets.py` after any approved asset update to
confirm active asset hashes and dimensions still match `manifest.json`.
