# Product Requirements Document — Recolour GUI

> Living document. Last updated: June 2026.

---

## Problem Statement

Most free colour-replacement tools either:
1. Use simple RGB matching (inaccurate — misses anti-aliased edges, JPEG noise, gradients)
2. Upload your image to a third-party server (privacy risk — opaque ToS, potential training data use)
3. Require heavy software (GIMP/Photoshop) with steep learning curves

No free, simple, local-first tool exists with perceptual (Delta-E) colour matching.

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

## Core Differentiators

| Differentiator | Why it matters |
|---|---|
| **Delta-E perceptual matching** | Handles anti-aliased edges, JPEG noise, gradients — RGB tools can't |
| **100% local processing** | Image never leaves your machine — zero upload, zero data risk |
| **Free, open source** | No freemium wall, no account required |
| **Region selection** | Restrict replacement to a drawn area — prevents accidental over-replacement |
| **Inpainting** | Fill removed pixels with surrounding content — not just a flat replacement colour |

---

## Competitive Landscape

| Tool | Type | Free? | Delta-E? | Region? | Inpaint? | Processing | Data risk |
|---|---|---|---|---|---|---|---|
| remove.bg | Web app | Freemium | No (AI) | No | AI | ☁️ Their servers | High — images stored, used for AI training |
| Canva Magic Erase | Web app | Freemium | No (AI) | No | AI | ☁️ Their servers | High — ToS grants broad usage rights |
| vayce.app | Web app | Free | No | No | No | ☁️ Unknown | Unknown — no clear privacy policy |
| imageonline.io | Web app | Free | No | No | No | ☁️ Their servers | Medium — claims deletion after processing |
| GIMP | Desktop | Free | No | Yes | Yes | 🖥️ Local | Zero |
| Photoshop | Desktop | Paid | No | Yes | Yes | 🖥️ Local (AI = cloud) | Low offline, High for AI features |
| **Recolour (this project)** | Local web | **Free** | ✅ | ✅ (T17) | ✅ (T16/T19) | 🖥️ **Local only** | **Zero** |

### Key gap
GIMP is the only other truly local free option — but no Delta-E, and high learning curve. **Recolour is the only tool combining local processing + perceptual matching + simple GUI.**

---

## Opportunities

### 1. Privacy-first positioning
"100% local — your image never leaves your device" is a headline differentiator. Lean into this explicitly in UI and README. A visible badge in the GUI reinforces trust.

### 2. Chrome Extension (zero-server)
T14 notes already flag this. Canvas API processing means no Node server needed — reducing friction to near-zero for non-technical users. Strongest privacy story possible.

### 3. Electron desktop app
Packages the local server into a double-click app. Removes the `node server.js` barrier entirely. Widens addressable audience significantly.

### 4. WASM / client-side hosted version
Host a version where all processing runs in-browser via WebAssembly. Zero upload, but also zero install. Best of both worlds — though higher engineering effort.

### 5. Batch processing
None of the free web tools support batch. Power users (photographers, designers) processing multiple images at once have nowhere to go.

---

## Positioning Statement

> For designers, photographers, and power users who need precise colour replacement without sacrificing privacy, Recolour is the only free, local-first tool that uses perceptual Delta-E matching — so your images stay on your machine and the results are actually accurate.

---

## Roadmap (from issues)

| Issue | Feature | Phase |
|---|---|---|
| T14 | Local web GUI (drag-drop, before/after, download) | Next |
| T17 | Region selection (bounding box) | Near |
| T18 | DeltaE slider with live pixel-count preview | Near |
| T16 | Nearest-neighbour inpainting | Mid |
| T19 | Content-aware fill (OpenCV/Python) | Far |

---

## Out of Scope (for now)

- Authentication / user accounts
- Cloud hosting / SaaS
- AI-based recolouring
- Mobile app
