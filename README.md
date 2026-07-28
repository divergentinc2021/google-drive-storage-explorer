# Google Drive Storage Explorer

A SpaceSniffer-style storage treemap for the **studiouih@uwc.ac.za** Google
Drive, served entirely from Apps Script — plus the triage lists that say what is
safe to move to the QNAP and what must stay.

## What it does

- **Treemap** — squarified layout on canvas, hand-rolled, no CDN. Click a folder
  to zoom, breadcrumbs to come back.
- **Colour by size** — sequential red ramp; negligible files fade to grey,
  the mass goes deep red.
- **Colour by age** — ordinal blue ramp over five activity bands, so dead regions
  read as solid dark blocks.
- **Dead folders** — folders whose every file is past the threshold
  (3 months → 2 years). Only the topmost folder of a dead chain is listed.
- **Migration classes** — separates the two things people conflate:
  - *dead binaries* — the only category that actually frees quota
  - *Google-native files* — Docs/Sheets/Slides consume **~0 quota**, so deleting
    them frees nothing. They are an export job, not a space job.
- **Manifest CSV** — per-file class + recommended action, to drive rclone.
- **Gated trash** — reversible `trashed:true` only, never a permanent delete.

## Why the sync engine is not in Apps Script

Apps Script runs on Google's servers and cannot reach a LAN address, so it can
never write to the NAS. The QNAP runs rclone and polls outbound; Apps Script is
the dashboard, the inventory and the config store. Full setup:
[docs/QNAP_SYNC.md](docs/QNAP_SYNC.md).

## Layout

```
apps-script/     the deployed project (clasp root)
  Code.gs        scan, classify, config, manifest, gated trash
  Index.html     shell — includes the partials below
  Styles.html    tokens + layout (validated ramps live here)
  Treemap.html   squarified layout + canvas renderer
  Dashboard.html app logic
docs/QNAP_SYNC.md
tools/
  make_ramp.mjs      derives the size ramp (run, don't hand-pick)
  build_preview.mjs  assembles a browser preview from the real sources
```

## Local preview

```bash
node tools/build_preview.mjs && open preview/index.html
```

Builds `preview/index.html` from the **actual** `apps-script/*.html` with a mock
backend and synthetic Drive data, so the UI under test is the same bytes that
get deployed. Use it for any UI change — an Apps Script deploy is a slow way to
discover a typo.

## Deploy

```bash
source ~/.claude/switch-clasp.sh studio
cd apps-script && clasp push
```

`clasp push` is free. `clasp deploy` spends one of the project's **200 lifetime
versions**, which cannot be reclaimed — batch deploys.

## House rules

- **No IIFEs in any `<script>` block.** The partials concatenate into one
  document; an IIFE makes its helpers invisible to the next block and the only
  symptom is a button that silently does nothing.
- **The colour ramps are derived and validated, not chosen.** Re-run
  `tools/make_ramp.mjs` and the dataviz validator before changing them. The size
  ramp's lightest step is *meant* to sit near the surface — that is the
  documented sequential exemption, not a contrast bug.
- **Storage numbers come from `quotaBytesUsed`**, the figure Google bills on —
  not `size`, which is absent on native files.

## Icon

`assets/icon.svg` is the master (rounded red square + a four-block treemap whose
opacity descends like the size ramp). PNGs are generated from it:

```bash
cd assets && qlmanage -t -s 512 -o . icon.svg && mv icon.svg.png icon-512.png
for s in 192 32 16; do sips -z $s $s icon-512.png --out icon-$s.png; done
```

The opacity floor is 0.52 and the gaps are 18px on purpose — at 16px anything
fainter or tighter dissolves into the gradient and the icon reads as a plain red
square. Verify at 16px, not at 512.

Apps Script **ignores `<link rel="icon">`** in a web app's HTML; the tab icon
comes from `HtmlOutput.setFaviconUrl()`, set in `Code.gs` to a base64 data URI of
the SVG and wrapped in try/catch so a rejected URL can never take the app down.
If the tab shows Google's default instead, host `assets/icon-192.png` publicly
and put that URL in `FAVICON_URL`.
