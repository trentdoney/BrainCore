# BrainCore launch assets

The current BrainCore visuals are committed in this repository. Files marked `Active` are used by the README or GitHub presentation layer in this branch.

| File | Status | Dimensions | Format | Usage |
|---|---|---|---|---|
| `og.jpg` | Active | 1600 by 841 | JPEG | README hero block and social preview source |
| `architecture.jpg` | Active | 1600 by 921 | JPEG | README architecture section |
| `dashboard.jpg` | Active | 1600 by 900 | JPEG | README retrieval pipeline overview |
| `maintained-by-trent.jpg` | Active | 1200 by 397 | JPEG | README author note banner |
| `manifest.json` | Reference | n/a | JSON | Hash and dimension manifest |
| `README.md` | Reference | n/a | Markdown | Asset notes |

Notes:

- All visuals avoid hostnames, IP addresses, internal paths, and private
  metadata
- `og.jpg` is the active README hero and social preview source image
- The dashboard, architecture, and social preview images are regenerated
  current `v1.1.6` public README assets
- `maintained-by-trent.jpg` is the active author note banner
- Use `python scripts/verify-readme-assets.py` after any asset update to
  confirm active asset hashes and dimensions still match `manifest.json`
