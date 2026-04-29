# BrainCore launch assets

The current BrainCore visuals are committed in this repository. Files marked `Active` are used by the README or GitHub presentation layer in this branch.

| File | Status | Dimensions | Format | Usage |
|---|---|---|---|---|
| `logo-square.jpg` | Active | 500 by 500 | JPEG | README hero block |
| `logo-horizontal.png` | Active | 600 by 70 | PNG | Alternate wordmark |
| `og.jpg` | Active | 1200 by 630 | JPEG | GitHub social preview |
| `architecture.jpg` | Active | 1653 by 952 | JPEG | README architecture section |
| `dashboard.png` | Active | 1672 by 941 | PNG | README retrieval pipeline overview |
| `manifest.json` | Reference | n/a | JSON | Hash and dimension manifest |
| `README.md` | Reference | n/a | Markdown | Asset notes |

Notes:

- All visuals avoid hostnames, IP addresses, internal paths, and private
  metadata
- The square logo is now the active README hero image
- The dashboard, architecture, and social preview images are regenerated
  current `v1.1.5` public README assets
- Use `python scripts/verify-readme-assets.py` after any asset update to
  confirm active asset hashes and dimensions still match `manifest.json`
