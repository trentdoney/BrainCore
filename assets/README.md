# BrainCore launch assets

The current BrainCore visuals are committed in this repository. Files marked
`Active` are safe for README, website, or GitHub presentation use. Historical
image files may remain in the directory, but only manifest-listed active assets
should be referenced by public docs.

| File | Status | Dimensions | Format | Usage |
|---|---|---:|---|---|
| `og.jpg` | Active | 1200 by 630 | JPEG | README hero and website/Open Graph/social link preview |
| `github-social-preview.jpg` | Active | 1280 by 640 | JPEG | GitHub repository social preview upload |
| `website-lifecycle.jpg` | Active | 1200 by 630 | JPEG | README architecture section |
| `website-recall-audit.jpg` | Active | 1200 by 630 | JPEG | README overview image |
| `maintained-by-trent.jpg` | Active | 1200 by 397 | JPEG | README author note banner |
| `manifest.json` | Reference | n/a | JSON | Hash, dimension, visible-claim, and alt-text manifest |
| `README.md` | Reference | n/a | Markdown | Asset notes |

## Social and Website Image Rules

- Website/Open Graph/social link images use `1200x630`.
- GitHub repository social preview uses `1280x640` and should be uploaded in
  repository settings.
- Active social images avoid dense metric cards, stale schema counts, badges,
  tiny labels, version numbers, and public benchmark claims.
- All visible text must be listed in `manifest.json`.
- All visuals must avoid hostnames, IP addresses, internal paths, private
  project names, tokens, and deployment-only metadata.

## Source Prompts

The lifecycle assets were generated as simple raster presentation cards with
the exact visible text listed in `manifest.json`. If regenerating with an image
model, upload the previous BrainCore image only as loose brand reference and use
these prompts.

### `og.jpg`

```text
Use the uploaded previous BrainCore social image as loose brand reference only. Create a professional GitHub repository and website social preview image at 1200x630. Solid dark GitHub-like background, high contrast, clean modern sans-serif typography. Text exactly: "BrainCore" and below it "Evidence-first memory for AI agents". Small footer text exactly: "PostgreSQL · pgvector · MCP". Add a subtle abstract memory graph and lifecycle ring on the right side, sparse and elegant. No metric cards, no badges, no code screenshots, no tiny labels, no paragraphs, no extra words, no pseudo-text. Keep all important content inside a 90px safe margin. Teal and blue accent lines only. It must remain readable when scaled down to 320px wide.
```

### `github-social-preview.jpg`

```text
Use the uploaded previous BrainCore image only for brand continuity. Create a 1280x640 GitHub repository social preview. Minimal professional developer-tool aesthetic. Text exactly: "BrainCore" and "Enterprise memory lifecycle for AI agents". Small footer text exactly: "Evidence · recall audit · MCP controls". Use a solid dark background, large readable type, restrained teal/blue accents, and one simple lifecycle-memory graph visual. No crowded UI panels, no old metrics, no schema counts, no badges, no tiny text, no extra generated words. Keep all text centered within the safe area and readable at small thumbnail size.
```

### `website-lifecycle.jpg`

```text
Create a 1200x630 website illustration for BrainCore's enterprise memory lifecycle. Dark professional background, clean technical diagram style, not a dashboard screenshot. Title text exactly: "Memory lifecycle overlay". Five large stage labels only: "Ingest", "Score", "Recall", "Audit", "Control". Show a simple left-to-right flow with sparse nodes and a protected evidence layer underneath. Use teal, blue, and white accents. No paragraphs, no tiny labels, no random text, no metric cards, no screenshots. Keep the composition center-safe and readable on mobile.
```

### `website-recall-audit.jpg`

```text
Create a 1200x630 website illustration for BrainCore recall audit and admin controls. Professional dark developer-tool visual style. Title text exactly: "Recall audit + admin control". Use four large labels only: "Retrieve", "Inject", "Omit", "Feedback". Show an abstract retrieval package flowing into an audit ledger and a simple control switch labeled "Suppress / Retire". No extra text, no tiny UI labels, no metrics, no badges, no clutter. High contrast, spacious layout, teal/blue accents, readable at 320px preview width.
```

Run `python scripts/verify-readme-assets.py` after any asset update to confirm
active asset hashes and dimensions still match `manifest.json`.
