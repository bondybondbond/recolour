# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [3.1.0] — Unreleased

### Added
- **Smart fill: BFS / Fast-Marching geodesic fill** (T42, fixes #32, guard for #31): replaces the cardinal distance-weighted scan with a multi-source BFS that follows connected (geodesic) paths from the mask boundary inward. Fixes corner/edge pixels left unfilled on full-perimeter watermarks (#32). Handles concave masks and textured/gradient backgrounds without seams. Adds `options.maxFillRatio` (engine) / `0.8` (GUI): when the fill set exceeds 80% of the image region the fill is skipped and the canvas-hint pill turns amber — prevents the main-thread glitch at extreme tolerance (#31 partial).
- **Smart-fill edge dilation** (T30): smart fill now expands the colour-match mask by 1px before reconstructing, so anti-aliased watermark/text edges are filled from the true background instead of surviving as a faint halo. Automatic when Smart fill is on — no new control. Engine: `smartFill` gains an `options.dilate` radius (default 0 preserves legacy behaviour; the GUI passes 1).
- **Custom colour-picker popover** (T28): the "+" button in Panel 2 now opens a bespoke colour picker anchored directly to the button. Includes a saturation/value square, hue slider, hex field (primary), and RGB triplet (secondary) — all simultaneously visible, no mode switching, no HSL inputs. Replaces the native `<input type=color>` which Chrome pinned to the viewport top-left. Colour is committed to recents only on confirm; Esc / outside-click cancels with no history change.
- **Cursor-as-loupe eyedropper** (T27): while the eyedropper is armed the system cursor is hidden and the pixel-zoom magnifier loupe is centred exactly on the pointer. The centre crosshair cell is the pixel that will be picked on click, eliminating the alignment gap of the previous 18px-offset design. Grid, adaptive grid lines, and crosshair rendering unchanged; Esc / re-click disarms and restores the cursor.
