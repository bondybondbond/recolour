# Product Requirements Document — Recolour GUI

> Living document. Last updated: June 2026.

---

## Problem Statement

Most free colour-replacement tools either:

1. Use simple RGB matching (inaccurate — misses anti-aliased edges, JPEG noise, gradients, shades)
2. Upload your image to a third-party server (privacy risk — opaque ToS, potential training data use)
3. Require heavy software (GIMP/Photoshop) with steep learning curves

No free, simple, local-first tool exists with perceptual (Delta-E) colour matching **or** neighbour-aware replacement.

---

## Target User

Power users who need precise, tolerance-based colour removal (watermarks, logos, overlaid text, background swaps) without:

- Paying for Photoshop
- Learning GIMP
- Uploading sensitive/proprietary images to a server

**Key segments:**

- Photographers protecting unreleased work
- Designers handling client brand assets under NDA
- Developers doing batch image prep
- Anyone removing watermarks from proprietary imagery

---

## Competitor UX Review (hands-on)

### vayce.app

- **Good:** Extensive customisation (tolerance, softness, strength, transparency), good colour picker
- **Bad:** Too many settings — overwhelming for most users; before/after requires too many clicks
- **Missing:** No perceptual matching; tolerance failed to eliminate shades/greys in real-world test; no neighbour-aware replacement
- **Verdict:** Over-engineered UI, under-powered engine

### imageonline.io

- **Good:** Most straightforward; **live preview on tolerance drag is excellent UX** — instant feedback loop we should replicate
- **Bad:** No true before/after toggle (setting tolerance to 0 is a workaround, not a feature)
- **Missing:** Same engine limitations as vayce — RGB-only, no perceptual matching, no inpainting
- **Verdict:** Best UX of the free tools, but weakest engine

### Key finding from testing

Neither tool could correctly eliminate shades of grey/gradient variants of a target colour. This is precisely the Delta-E advantage — and it's unaddressed in any free tool.

---

## Competitor Intelligence (June 2026 audit)

Direct competitors doing pixel-level colour replacement in the browser:

| Tool | Key differentiator | Notes |
|---|---|---|
| theimagechange.com | Closest match — eyedropper + HEX + tolerance slider, fully local | Best UX benchmark for our core flow |
| PictTools | **Brush mask** for zone-based editing, no signup, HEIC support | Brush mask is a compelling feature gap we don't have |
| Vayce | Tolerance + softness + **shading preservation** + stacked replacements | Shading preservation = perceptual match angle; naming better than "Include shades" |
| Toolschimp | Auto-detects palette, shows colour % usage, multi-replacement in one pass | Palette auto-detection is a useful discovery feature |
| imagecolorchanger.com | Clean 3-step UX, practical framing (product photos, logos) | Good copy/positioning inspiration |

AI-powered tools (different category, not direct competitors but signals where the market is heading): LimeWire, Fotor, PixelBin — AI prompts / object selection rather than pixel-picking.

### Competitor features worth tracking (not on roadmap yet)

| Feature | Seen in | Priority consideration |
|---|---|---|
| Brush mask — paint a zone to restrict replacement | PictTools | High — more targeted than region selection (T17); complementary |
| Shading preservation / smooth mode | Vayce, PictTools ("Smooth" method) | Already addressed by our Delta-E engine; marketing angle |
| Palette auto-detection (show all colours in image) | Toolschimp | Medium — useful for discovery, especially for watermark removal |
| "New image" button (reload without refresh) | PictTools | Low — easy to add; improves iterative workflow |
| Stacked replacements (multiple colour pairs in one pass) | Vayce | Medium — T5 already adds array input to the Node package; GUI equivalent is T25 territory |
| Undo / redo | PictTools (undo arrows in toolbar) | High — no way to recover from an accidental replace; GitHub issue T26 |
| Cursor-as-loupe (magnifier replaces the cursor itself) | Loupe app | Medium — better spatial awareness than floating loupe; cleaner UX |

### Competitive positioning summary

Privacy-first (local processing) is now table stakes — every listed competitor does it. The real differentiators are:
1. **Delta-E perceptual matching** — none of the above have it; we have it
2. **Brush mask** (PictTools) — the most impactful feature gap to close after MVP
3. **UX simplicity** — don't over-engineer like Vayce; match theimagechange.com's minimal 3-control flow

---

## Core Differentiators

| Differentiator                  | Why it matters                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Delta-E perceptual matching** | Correctly handles shades, gradients, anti-aliased edges, JPEG noise — RGB tools demonstrably fail this |
| **Neighbour-aware replacement** | Replace matched pixels with surrounding colours — no other free tool has this                          |
| **100% local processing**       | Image never leaves your machine — zero upload, zero data risk                                          |
| **Free, open source**           | No freemium wall, no account required                                                                  |
| **Region selection**            | Restrict replacement to a drawn area — prevents accidental over-replacement                            |
| **Live tolerance preview**      | Instant feedback (stolen from imageonline UX) — must-have                                              |

---

## Competitive Landscape

| Tool                        | Free?    | Delta-E? | Neighbour replace? | Region? | Inpaint?    | Processing         | Data risk |
| --------------------------- | -------- | -------- | ------------------ | ------- | ----------- | ------------------ | --------- |
| remove.bg                   | Freemium | No (AI)  | No                 | No      | AI          | ☁️ Server          | High      |
| Canva Magic Erase           | Freemium | No (AI)  | No                 | No      | AI          | ☁️ Server          | High      |
| vayce.app                   | Free     | No       | No                 | No      | No          | ☁️ Unknown         | Unknown   |
| imageonline.io              | Free     | No       | No                 | No      | No          | ☁️ Server          | Medium    |
| GIMP                        | Free     | No       | No                 | Yes     | Yes         | 🖥️ Local          | Zero      |
| Photoshop                   | Paid     | No       | No                 | Yes     | Yes         | 🖥️ Local*         | Low*      |
| **Recolour (this project)** | **Free** | ✅        | ✅ (T16)            | ✅ (T17) | ✅ (T16/T19) | 🖥️ **Local only** | **Zero**  |

*Photoshop AI features require cloud.

### Key gap

No free tool combines local processing + perceptual matching + neighbour-aware replacement. **Recolour will be the first.**

---

## UX Principles (informed by competitor review)

1. **Live preview on every control change** — drag tolerance slider = instant pixel feedback (imageonline does this right)
2. **Simple first, power second** — lead with 3 inputs (image, target colour, replace colour); advanced settings collapsed by default (vayce does the opposite wrong)
3. **Explicit before/after toggle** — single click, not a workaround; essential since live preview makes before state hard to recall
4. **Privacy badge always visible** — "🔒 Processed locally — your image never leaves your device"

---

## Opportunities

### 1. Privacy-first positioning

"100% local — your image never leaves your device" is a headline differentiator vs every free web tool.

### 2. Chrome Extension (zero-server)

Canvas API processing — no Node server needed, strongest privacy story, near-zero friction for non-technical users.

### 3. Electron desktop app

Double-click app, no `node server.js`. Widens addressable audience significantly.

### 4. WASM / client-side hosted version

Zero upload + zero install. Best of both worlds — higher engineering effort.

### 5. Batch processing

No free tool supports batch. Unmet need for photographers and designers.

---

## Positioning Statement

> For designers, photographers, and power users who need precise colour replacement without sacrificing privacy, Recolour is the only free, local-first tool with perceptual Delta-E matching and neighbour-aware replacement — so your images stay on your machine and the results actually work.

---

## Roadmap (from issues)

| Issue | Feature                                                         | Phase |
| ----- | --------------------------------------------------------------- | ----- |
| T14   | Local web GUI (drag-drop, live preview, before/after, download) | Next  |
| T17   | Region selection (bounding box)                                 | Near  |
| T18   | DeltaE slider with live preview                                 | Near  |
| ~~T16~~ | ~~Nearest-neighbour inpainting~~ ✅ Shipped (cardinal distance-weighted interpolation) | Done |
| T19   | Content-aware fill (OpenCV/Python)                              | Far   |

---

## Out of Scope (for now)

- Authentication / user accounts
- Cloud hosting / SaaS
- AI-based recolouring
- Mobile app
