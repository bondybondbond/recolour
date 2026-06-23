# GUI Design Session — 24 June 2026

## Status
Paused mid-session. Resume tomorrow to finalise architecture decision and hand brief to Claude Code.

---

## Decisions Made ✅

### Architecture (UNDECIDED — debate tomorrow)
Two options on the table:

**Option A: Canvas API (browser-only)**
- Zero-latency live updates (critical for "no Apply button" spec)
- Single HTML file, no server
- CWS-ready out of the box
- Requires ~50-line deltaE rewrite (Jimp dropped)
- T16/T19 (inpainting, content-aware) harder in future

**Option B: Node/Express**
- Keeps all existing Jimp logic (T3–T7)
- 50–200ms round-trip per slider drag = laggy
- Incompatible with "live updates, no Apply button" spec
- Not CWS-able

**Lean:** Canvas API wins given live-update spec. Debate tomorrow.

---

### Layout
- **Prototype A style** — single page, image left, sidebar right
- No multi-step wizard
- No Apply button — all changes live/instant

### Panel 1 — "Replace this colour"
- Colour picker well → click opens magnified pixel picker (eyedropper)
- Tolerance slider (deltaE 0–100), live preview, shows "X px matched" (T18)
- Toggle: **"Include shades"** (auto neighbouring colours within tolerance)

### Panel 2 — "Replace with"
- 5 recent colours (quick picks) — click opens full palette picker
- Toggle: **"Smart fill"** — fills from surrounding pixels (T16, flagged as future/disabled)

### Footer
- Export button only

### Image area
- Full canvas
- Empty state = full-canvas dropzone, sidebar disabled/greyed until image loaded
- Before/after via **modal** (full-size, after dominant/larger, before smaller on left)
- No persistent split-view (causes eye disorientation)

### Naming decisions
- "Include shades" preferred over "Fuzzy match" or "Match similar"
- "Smart fill" for T16 inpainting toggle

---

## Tomorrow's Agenda

1. **Confirm Canvas API vs Express** — final call
2. **Build updated Prototype A** with:
   - Empty state (dropzone, sidebar greyed)
   - Panel 1: eyedropper well + tolerance slider + "Include shades" toggle
   - Panel 2: 5 recent picks + palette modal + "Smart fill" (future, disabled)
   - Before/after modal (full-size)
   - Export footer button
3. **Write Claude Code brief** once prototype approved

---

## Reference: Prototype A (original)

Key things to change in tomorrow's version vs original Prototype A:
- Remove step-progress tracker from sidebar (not needed in single-page flow)
- Replace "colour to replace" well with proper eyedropper/magnifier interaction
- Replace "Replace with" well with 5 recent picks grid + palette opener
- Add "Include shades" toggle to Panel 1 (below tolerance)
- Add "Smart fill" toggle to Panel 2 (disabled, future label)
- Add empty/disabled state for sidebar before image loaded
- Add before/after modal trigger (not inline)
- Move Export to sidebar footer

---

## Related Issues
- T14 — Build local web GUI (this task)
- T15 — Chrome Web Store (future, Canvas API path enables this)
- T16 — Nearest-neighbour inpainting ("Smart fill" toggle, future)
- T18 — deltaE tolerance slider + pixel count (in spec for Panel 1)
