# GUI Design Session — 24 June 2026

## Status
Paused mid-session. Resume next session to build final prototype + write Claude Code brief.

---

## Decisions Made ✅

### Architecture — DECIDED: Canvas API (browser-only)
- Zero-latency live updates — required for "no Apply button" spec
- Single HTML file, no server, open directly in Chrome
- Testable locally with Chrome DevTools (including e2e)
- CWS-ready: same file + manifest.json = Chrome extension
- Hostable on any static host (GitHub Pages, Netlify) for public access
- Requires ~50-line deltaE rewrite (Jimp dropped) — acceptable
- T16/T19 (inpainting, content-aware fill) harder in Canvas — acceptable, both are far-future
- Performance on very large images (10MP+) may be slow — mitigate later with Web Workers if needed

### Distribution strategy
- **Primary:** host on static site (GitHub Pages or Netlify) — public, free
- **Secondary:** wrap same codebase for CWS — one-time $5 dev fee, parallel channel
- Single codebase serves both. No divergence.
- CWS maintenance: low (resubmit on updates, handle rare Chrome API deprecations ~1/year)
- CWS publisher profile: worth building if extension is quality — cross-promotion between extensions, PM portfolio signal

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

## Next Session Agenda

1. **Build updated Prototype A** (final HTML mockup) with:
   - Empty state (dropzone, sidebar greyed)
   - Panel 1: eyedropper well + tolerance slider + "Include shades" toggle
   - Panel 2: 5 recent picks + palette modal + "Smart fill" (future, disabled)
   - Before/after modal (full-size, after dominant)
   - Export footer button
2. **Review and approve prototype**
3. **Write Claude Code brief** for actual build

---

## Prototype A — Change List vs Original
- Remove step-progress tracker (not needed in single-page flow)
- Replace colour wells with: eyedropper/magnifier picker (Panel 1) + 5 recent picks grid with palette opener (Panel 2)
- Add "Include shades" toggle to Panel 1 (below tolerance slider)
- Add "Smart fill" toggle to Panel 2 (disabled, future label)
- Add empty/disabled state for sidebar before image loaded
- Add before/after modal trigger button (not inline split)
- Move Export to sidebar footer
- Remove Reset button (live updates make it less necessary — TBD)

---

## Related Issues
- T14 — Build local web GUI (this task)
- T15 — Chrome Web Store (future, Canvas API path enables this)
- T16 — Nearest-neighbour inpainting ("Smart fill" toggle, future)
- T18 — deltaE tolerance slider + pixel count (in spec for Panel 1)
