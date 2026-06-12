# Kris Photo Edit

A personal Lightroom Classic–style photo editor that runs entirely in the browser.

**Live app:** https://jellyfish1456.github.io/Kris_photo_Edit/

## Features

- **Library module** — import photos (button or drag & drop), thumbnail grid,
  star ratings, pick/reject flags, and filtering by rating or flag.
- **Develop module** — real-time GPU (WebGL) adjustments:
  white balance (temp/tint), exposure, contrast, highlights, shadows,
  whites, blacks, vibrance, saturation, sharpening, vignette, and 90° rotation.
- **Pixel Stretch** — the viral smear effect: pick an edge (↑ ↓ ← →), choose how
  much of the frame to stretch, and dial in Wave/Frequency for flowing ribbons.
- **Non-destructive** — originals are never touched; edits are settings stored
  per photo, with a live RGB histogram and hold-to-compare Before view.
- **Persistent catalog** — photos and edits are saved in your browser
  (IndexedDB) and survive reloads. Nothing is uploaded anywhere.
- **Presets** — Punch, Warm Golden, Cool Blue, B&W Classic, Matte Fade, High Key,
  plus copy/paste settings between photos.
- **Export** — render edits to a JPEG download with quality and size options.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `G` / `D` | Library / Develop module |
| `←` `→` | Previous / next photo |
| `0`–`5` | Set star rating |
| `P` / `X` / `U` | Pick / Reject / Unflag |
| `\` (hold) | Show original (before) |
| `Delete` | Remove photo from catalog |
| Double-click slider | Reset that slider |

## Tech

No build step, no dependencies: plain HTML/CSS/JS with a WebGL fragment-shader
pipeline for the develop adjustments. Serve the folder statically (or just open
it via GitHub Pages).
