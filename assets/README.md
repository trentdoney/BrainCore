# BrainCore launch assets

The current BrainCore visuals are committed in this repository. Files marked `Active` are used by the README or GitHub presentation layer in this branch.

| File | Status | Dimensions | Format | Usage |
|---|---|---|---|---|
| `og-v5.jpg` | Active | 1600 by 841 | JPEG | README hero block |
| `logo-square.jpg` | Active | 500 by 500 | JPEG | Alternate square logo |
| `logo-horizontal.png` | Active | 600 by 70 | PNG | Alternate wordmark |
| `og.jpg` | Active | 1200 by 630 | JPEG | GitHub social preview |
| `architecture.jpg` | Active | 1600 by 921 | JPEG | README architecture section |
| `dashboard.jpg` | Active | 1600 by 900 | JPEG | README retrieval pipeline overview |
| `dashboard.png` | Retired | 1672 by 941 | PNG | Superseded README dashboard |
| `manifest.json` | Reference | n/a | JSON | Hash and dimension manifest |
| `README.md` | Reference | n/a | Markdown | Asset notes |

Notes:

- All visuals avoid hostnames, IP addresses, internal paths, and private
  metadata
- `og-v5.jpg` is the active README hero image
- The dashboard, architecture, and social preview images are regenerated
  current `v1.1.5` public README assets
- Use `python scripts/verify-readme-assets.py` after any asset update to
  confirm active asset hashes and dimensions still match `manifest.json`
