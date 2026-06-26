# Changes from upstream (turakvlad/replace-color@2.3.0)

## [3.3.0] — 2026-06-26

### Added
- **Browser GUI — interactive wiring** (`web/app.js`): first JavaScript layer over the T22 HTML/CSS shell.
  - **File loading**: drag-drop onto the empty dropzone, click-to-browse (hidden file input), drag-to-canvas-area when an image is already loaded (to swap it), clipboard paste (Ctrl+V / Cmd+V).
  - **On-canvas eyedropper**: click the picker well to arm; a floating 9×9 pixel-zoom magnifier loupe tracks the cursor; click to confirm the target colour, Esc to cancel.
  - **Magnifier loupe**: positioned above-right of cursor; pixel grid with adaptive colour (dark on light, light on dark); hides when cursor leaves the image area.
  - **One-shot live preview**: on pick, runs `RecolourEngine.replaceColour` with current tolerance + selected replace swatch; result painted to canvas.
  - **Reset**: restores original image and clears picked colour state.

### Changed
- Docs reorganised: `PRD.md` + `CHANGES.md` moved to `docs/`; upstream `CHANGELOG.md` + `GUI_SESSION_NOTES.md` archived to `docs/archive/`.
- `docs/PRD.md` updated with June 2026 competitor intelligence audit and feature-gap tracking table (PictTools, Vayce, Toolschimp, theimagechange.com, imagecolorchanger.com).

## [3.2.0] — 2026-06-25

### Added
- **Browser GUI shell** (`web/index.html` + `web/styles.css`): two-panel dark-theme interface with empty state (full-canvas dropzone) and loaded visual state (canvas draw surface). CSS-only state switching via `.app.loaded` / `.sidebar.disabled` classes. No JavaScript — visual shell only; interactive wiring lands in T23+.
  - Panel 1: Target colour — eyedropper well placeholder, tolerance slider (Delta-E 0–100), Include shades toggle.
  - Panel 2: Replace colour — 6-swatch recent-colours grid, disabled Smart fill toggle (labelled Soon).
  - Footer: Reset + Export buttons.
  - Deliberate divergences from T22 issue text (superseded by approved Prototype A): sidebar width 300px (issue said 280px), footer includes Reset + Export (issue listed Export only).

## [3.1.1] — 2026-06-24

### Documentation
- Added **Security considerations** section to README covering: SSRF risk when passing user-supplied URLs, decompression-bomb risk from untrusted image inputs, and event-loop blocking from the synchronous pixel scan on large images.

## [3.1.0] — 2026-06-23

### Added
- **Configurable return type** (`output` option): `replaceColor` now accepts `output: 'jimp'` (default, unchanged), `output: 'buffer'` (returns an encoded image `Buffer`), or `output: 'base64'` (returns a full `data:<mime>;base64,...` data URL string). Addresses upstream issue #17.
- **`outputMime` option**: controls the encoding format for `buffer` and `base64` output (default: `image/png`). Accepts any MIME string supported by Jimp (e.g. `Jimp.MIME_JPEG`). Ignored when `output: 'jimp'`.

## Package rename
- Package renamed from `@bondybondbond/replace-color` to `@bondybondbond/recolour`; source and test files renamed to match (`src/recolour.js`, `src/utils/recolour-error.js`, `test/recolour.js`)

## Bug fixes
- **validate-colors.js**: Fixed typo where `colors.targetColor.length` was checked instead of `colors.replaceColor.length` when validating hex `replaceColor`
- **recolour.js**: Fixed `Jimp.read is not a function` error in Electron/webpack environments by handling both CJS and ESM module exports (`Jimp.default || Jimp`)

## New features
- **Multiple colour replacement**: `colors` option now accepts an array of `{ type, targetColor, replaceColor, deltaE }` objects to replace multiple colours in a single pass. Each entry can override `deltaE` individually.

## Dependency updates
- `jimp`: `^0.9.3` → `^0.22.12` (API-compatible, fixes jpeg-js CVE)
- `color-convert`: `^1.9.3` → `^2.0.1`
- `mocha`: `^5.2.0` → `^10.0.0`
- Removed deprecated `request` / `request-promise` dev deps
- Removed `standard` linter (add your own if needed)
- Node engine: `>= 6` → `>= 16`

## Security
- Cleared 10 of 14 known CVEs from upstream (3 critical, 1 high, 6 moderate removed)
- Pinned `serialize-javascript` to `7.0.6` via `overrides` (fixes high CVE in mocha's dev dep chain)
- 4 moderate CVEs remain in `file-type` via jimp 0.22.x transitive chain — unfixable without jimp 1.x API migration; tracked separately
