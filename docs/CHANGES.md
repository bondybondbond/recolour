# Changes from upstream (turakvlad/replace-color@2.3.0)

## [Unreleased] — Browser GUI (in progress)

### Added
- **Region selection** (`web/index.html`, `web/styles.css`, `web/app.js`, `web/recolour-engine.js`): "Select area" button in the canvas toolbar lets the user drag a bounding box on the image; colour replacement and smart fill are then constrained to that rectangle. Marching-ants animated border with exterior dim (`box-shadow`) shows the active selection. A × handle clears the region (committing any in-region work first). Region persists across multiple picks and passes; Reset and new image load also clear it. Engine change is backwards-compatible — omitting the region parameter reproduces the previous whole-image behaviour.
- **Browser GUI shell** (`web/index.html`, `web/styles.css`): two-panel dark-theme interface. Empty state: full-canvas dropzone. Loaded state: canvas draw surface. CSS-only state switching via `.app.loaded` / `.sidebar.disabled`.
  - Panel 1 (Target colour): eyedropper well, deltaE tolerance slider (0–100, default 12), Include shades toggle.
  - Panel 2 (Replace colour): recent-colour swatch row (up to 5, persisted to `localStorage`, most-recent-first; seeds white + black on first run), Smart fill toggle.
  - Footer: Undo + Reset + Export buttons.
- **Interactive wiring** (`web/app.js`): file loading (drag-drop, click-to-browse, canvas-area swap, clipboard paste), on-canvas eyedropper with 9×9 pixel-zoom magnifier loupe, one-shot live preview on colour pick, Reset.
- **Live tolerance re-scan**: dragging the tolerance slider re-runs the replacement in real time, coalesced to one render per `requestAnimationFrame`.
- **Recent colours + palette opener** (Panel 2): swatch click sets replacement colour and re-runs preview; **+** opener adds a new colour via the native colour picker (move-to-front dedupe, cap 5, `localStorage` persistence with graceful fallback).
- **Before / After comparison modal**: liquid-glass pill button (gated until a colour is picked) opens a full-viewport side-by-side modal. After panel captured via `canvas.toBlob()` + `URL.createObjectURL()`; blob URL revoked on close. Close via ×, Escape, or backdrop click.
- **Undo history + multi-pass colour stacking** (footer): each colour pick now commits the previous result onto a base image instead of discarding it, so multiple different colours can be replaced and kept in one session. Added an undo button (and **Ctrl+Z** / **Cmd+Z**) that steps back one operation at a time — discarding the live preview first, then popping committed operations (capped at 10). Reset clears all history.
- **Canvas API colour engine** (`web/recolour-engine.js`): pure-JS browser-side deltaE pixel scan — same CIE76/94/2000 formulas as the Node package, no Jimp dependency.
- **Smart fill** (`web/recolour-engine.js` `smartFill()`, Panel 2 toggle): replaces matched pixels by sampling the nearest original background pixel in each of 4 cardinal directions and blending with inverse-distance weights — no flat replacement colour required. Enables watermark removal on non-flat backgrounds without knowing the background colour in advance. Algorithm: single-pass cardinal distance-weighted interpolation (not onion-peel); avoids competing propagation fronts that produce chevron seams on gradient backgrounds.

### Fixed
- **Region clear (×) no longer replaces entire image** (`web/app.js`): pressing × previously nulled `region` before nulling `targetRgb`, causing a subsequent `renderPreview()` to run the colour replacement over the whole image. Fixed by calling `commitOperation()` first (bakes the in-region result), then nulling `targetRgb`, then clearing the region — preventing any whole-image re-render.
- **Eyedropper samples current image state** (`web/app.js`): after committing an operation (e.g. smart fill), the loupe and pick now read from the committed canvas state (`baseImageData`) rather than always sampling the original image. Re-picking a previously filled area correctly reflects the filled colours.

### Changed
- Default tolerance lowered from 35 to 12.
- Docs reorganised: `PRD.md` + `CHANGES.md` moved to `docs/`; upstream `CHANGELOG.md` + `GUI_SESSION_NOTES.md` archived to `docs/archive/`.

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
