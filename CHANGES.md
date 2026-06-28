# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [3.1.0] — Unreleased

### Added
- **Custom colour-picker popover** (T28): the "+" button in Panel 2 now opens a bespoke colour picker anchored directly to the button. Includes a saturation/value square, hue slider, hex field (primary), and RGB triplet (secondary) — all simultaneously visible, no mode switching, no HSL inputs. Replaces the native `<input type=color>` which Chrome pinned to the viewport top-left. Colour is committed to recents only on confirm; Esc / outside-click cancels with no history change.
- **Cursor-as-loupe eyedropper** (T27): while the eyedropper is armed the system cursor is hidden and the pixel-zoom magnifier loupe is centred exactly on the pointer. The centre crosshair cell is the pixel that will be picked on click, eliminating the alignment gap of the previous 18px-offset design. Grid, adaptive grid lines, and crosshair rendering unchanged; Esc / re-click disarms and restores the cursor.
