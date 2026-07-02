/*
 * recolour engine — browser-side Canvas colour replacement (T21).
 *
 * Dependency-free port of the core algorithm in ../src/recolour.js:
 *   read pixels -> RGB->LAB -> Delta-E vs target -> overwrite matches.
 * It drops jimp / color-convert / delta-e so the same logic runs in the browser
 * with no build step.
 *
 * Delta-E formula: CIE76 (Euclidean LAB distance) — fast enough for a live
 * tolerance slider. CIEDE2000 is intentionally NOT used here (perf over the last
 * few % of perceptual accuracy; see GUI_SESSION_NOTES.md).
 *
 * UMD wrapper: require()-able in Node (mocha tests) AND a `window.RecolourEngine`
 * global via <script src> in the browser. Avoids ES `import`, which fails on
 * file:// (CORS) — the GUI opens directly in Chrome with no server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.RecolourEngine = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  // sRGB [r,g,b] (0-255) -> CIELAB [L,a,b]. Coefficients copied verbatim from
  // color-convert's rgb.xyz + xyz.lab (D65) so results match the Node package by
  // construction. https://github.com/Qix-/color-convert/blob/master/conversions.js
  //
  // SPEC: pro editors pre-clamp RGB to [0,255] before LAB conversion. That is
  // already guaranteed here because callers feed Uint8ClampedArray/getImageData
  // data — but a future non-canvas caller must clamp first.
  function rgbToLab (rgb) {
    let r = rgb[0] / 255
    let g = rgb[1] / 255
    let b = rgb[2] / 255

    // Assume sRGB
    r = r > 0.04045 ? (((r + 0.055) / 1.055) ** 2.4) : (r / 12.92)
    g = g > 0.04045 ? (((g + 0.055) / 1.055) ** 2.4) : (g / 12.92)
    b = b > 0.04045 ? (((b + 0.055) / 1.055) ** 2.4) : (b / 12.92)

    let x = ((r * 0.4124) + (g * 0.3576) + (b * 0.1805)) * 100
    let y = ((r * 0.2126) + (g * 0.7152) + (b * 0.0722)) * 100
    let z = ((r * 0.0193) + (g * 0.1192) + (b * 0.9505)) * 100

    x /= 95.047
    y /= 100
    z /= 108.883

    x = x > 0.008856 ? (x ** (1 / 3)) : (7.787 * x) + (16 / 116)
    y = y > 0.008856 ? (y ** (1 / 3)) : (7.787 * y) + (16 / 116)
    z = z > 0.008856 ? (z ** (1 / 3)) : (7.787 * z) + (16 / 116)

    const l = (116 * y) - 16
    const a = 500 * (x - y)
    const bb = 200 * (y - z)

    return [l, a, bb]
  }

  // CIE76: plain Euclidean distance between two LAB colours. Mirrors the
  // delta-e package's getDeltaE76.
  function deltaE76 (lab1, lab2) {
    const dl = lab1[0] - lab2[0]
    const da = lab1[1] - lab2[1]
    const db = lab1[2] - lab2[2]
    return Math.sqrt((dl * dl) + (da * da) + (db * db))
  }

  // Normalise an optional region {x,y,width,height} into half-open pixel bounds
  // {x0,y0,x1,y1} clamped to the image (T17). A missing/invalid region → whole image.
  // Clamping here is the safety guard: callers can pass any rect and the scan can never
  // read or write outside the buffer.
  function clampRegion (region, width, height) {
    if (!region) return { x0: 0, y0: 0, x1: width, y1: height }
    var x0 = Math.max(0, Math.min(width, Math.floor(region.x)))
    var y0 = Math.max(0, Math.min(height, Math.floor(region.y)))
    var x1 = Math.max(x0, Math.min(width, Math.floor(region.x + region.width)))
    var y1 = Math.max(y0, Math.min(height, Math.floor(region.y + region.height)))
    return { x0: x0, y0: y0, x1: x1, y1: y1 }
  }

  /*
   * Replace every pixel within `tolerance` Delta-E of `targetRgb` with `replaceRgb`.
   *
   * @param {ImageData|{data,width,height}} imageData  RGBA pixel buffer. Mutated IN PLACE.
   * @param {number[]} targetRgb   colour to match, [r,g,b] (0-255).
   * @param {number[]} replaceRgb  replacement, [r,g,b] OR [r,g,b,a].
   *        Alpha is written ONLY when explicitly supplied — detected as
   *        replaceRgb.length === 4 && replaceRgb[3] !== undefined. A 3-element
   *        array leaves each matched pixel's original alpha untouched
   *        (mirrors src/recolour.js alpha handling).
   * @param {number} tolerance     Delta-E threshold (0-100). <= matches.
   * @param {object} [region]      Optional {x,y,width,height} in image pixel coords. When
   *        supplied, only pixels inside the rectangle are scanned/replaced (T17). Omitted →
   *        whole image (backwards compatible). Clamped to image bounds so a bad rect can
   *        never index outside the buffer.
   * @returns {{imageData: ImageData, matched: number}} the same buffer + match count.
   */
  function replaceColour (imageData, targetRgb, replaceRgb, tolerance, region) {
    const data = imageData.data
    const width = imageData.width
    const height = imageData.height
    const targetLab = rgbToLab(targetRgb) // hoisted: compute target LAB once, not per-pixel
    const hasAlpha = replaceRgb.length === 4 && replaceRgb[3] !== undefined
    const b = clampRegion(region, width, height)
    let matched = 0

    // Bounded double loop (T17): iterate only the region rows/cols. With the default
    // whole-image bounds this is the same pixel set as the old flat `for (i…)` scan.
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) {
        const i = (y * width + x) * 4
        const lab = rgbToLab([data[i], data[i + 1], data[i + 2]])
        if (deltaE76(lab, targetLab) <= tolerance) {
          data[i] = replaceRgb[0]
          data[i + 1] = replaceRgb[1]
          data[i + 2] = replaceRgb[2]
          if (hasAlpha) data[i + 3] = replaceRgb[3]
          matched++
        }
      }
    }

    return { imageData: imageData, matched: matched }
  }

  /*
   * Smart fill — BFS / Fast-Marching geodesic inpainting (T42; was cardinal in T16/#16).
   *
   * Build a mask of pixels matching the target colour, then reconstruct each masked pixel from the
   * surrounding background by a multi-source breadth-first fill: starting from mask-boundary pixels,
   * expand inward layer by layer, setting each pixel to the inverse-distance-weighted mean of its
   * already-KNOWN 8-neighbours (original background first; pixels finalized earlier in the BFS then
   * become sources for deeper layers). Equivalent in spirit to the Telea Fast Marching Method used in
   * GIMP heal / OpenCV inpaint.
   *
   * Why BFS over the old cardinal scan? Geodesic (path-following) distance never crosses a background
   * gap, so concave masks (a watermark with a hole) no longer pull a distant wrong colour, and
   * corner/edge pixels of a full-perimeter watermark always get reached and filled (fixes #32). On
   * textured/gradient backgrounds the locally-nearest sources dominate, so the fill blends in instead
   * of smearing one flat colour.
   *
   * Why no seam (cf. CORE-8)? The chevron seam of onion-peel came from UNORDERED ring-by-ring
   * aggregation with competing fronts. Here the FIFO dequeues strictly in non-decreasing distance
   * order, so the fill is a single monotonic front — sampling already-filled pixels is safe and is
   * precisely what lets interiors with no original neighbour fill at all (see CORE-8 addendum).
   *
   * FRINGE/HALO: anti-aliased letter edges fall just outside the exact-colour match and survive as a
   * faint halo. Pass `options.dilate` (px) to expand the mask before filling so that fringe is
   * reconstructed from true background instead. The GUI passes `dilate: 1` (T30); engine default 0.
   *
   * @param {ImageData|{data,width,height}} imageData  RGBA buffer. Mutated IN PLACE.
   * @param {number[]} targetRgb   colour to remove, [r,g,b] (0-255).
   * @param {number} tolerance     Delta-E threshold (0-100). <= matches (same as replaceColour).
   * @param {object} [options]     `options.dilate` (number, default 0) — expand the match mask by
   *        this many px before filling so anti-aliased edge pixels are reconstructed rather than left
   *        as a halo (T30). 0 reproduces the legacy mask.
   *        `options.maxFillRatio` (number, default 1 = off) — if the fill set covers more than this
   *        fraction of the region, skip the fill entirely and return `skipped: true` (the result
   *        would be garbage with so little background, and the work can stall the main thread — #31).
   *        The GUI passes 0.8.
   * @param {object} [region]      Optional {x,y,width,height} in image pixel coords. When supplied,
   *        only pixels inside the rectangle are masked + filled (T17); the region edge acts as a
   *        natural boundary (only in-region background is sampled). Omitted → whole image. Clamped.
   * @returns {{imageData: ImageData, matched: number, unfilled: number, skipped?: boolean}}
   *        matched = exact-colour match count (excludes dilated fringe). unfilled > 0 only when a
   *        masked pixel has no path to any background source (e.g. an all-target image). skipped:true
   *        when the maxFillRatio guard tripped — in that case the buffer is left untouched.
   */
  function smartFill (imageData, targetRgb, tolerance, options, region) {
    var data = imageData.data
    var width = imageData.width
    var height = imageData.height
    var n = width * height
    var targetLab = rgbToLab(targetRgb)
    var b = clampRegion(region, width, height) // half-open bounds; whole image when no region
    var p, o, x, y

    // 1. Build the match mask — one LAB pass over the region (whole image when unbounded),
    //    same matching rule as replaceColour.
    var mask = new Uint8Array(n)
    var matched = 0
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        p = y * width + x
        o = p * 4
        if (deltaE76(rgbToLab([data[o], data[o + 1], data[o + 2]]), targetLab) <= tolerance) {
          mask[p] = 1
          matched++
        }
      }
    }

    // 1b. Mask dilation (T30) → 2. #31 guard → 3. BFS geodesic fill. All three steps are shared
    //     with fillMaskRegion via _dilateMask + _bfsFill, so both entry points run byte-identical
    //     reconstruction. `matched` keeps reporting the ORIGINAL exact-colour match count — the
    //     dilated fringe does not inflate it.
    var dilate = (options && options.dilate) | 0
    var fillMask = _dilateMask(mask, width, b, dilate)
    var maxFillRatio = (options && typeof options.maxFillRatio === 'number') ? options.maxFillRatio : 1
    var fr = _bfsFill(imageData, fillMask, b, maxFillRatio)
    if (fr.skipped) return { imageData: imageData, matched: matched, unfilled: fr.unfilled, skipped: true }
    return { imageData: imageData, matched: matched, unfilled: fr.unfilled }
  }

  /*
   * Expand `mask` (1 = fill target) by Chebyshev radius `dilate` within bounds `b`, returning a NEW
   * fillMask. `dilate <= 0` → returns `mask` itself (no allocation; the legacy no-dilate path).
   *
   * Anti-aliased letter edges blend into the background and fall just outside an exact-colour match,
   * surviving the fill as a ghost halo; pulling them into the fill set reconstructs them instead
   * (T30). CRITICAL: read from `mask`, write to a separate `fillMask`, so a freshly-dilated pixel
   * cannot seed further growth in the same pass (that would silently bleed past `dilate` px).
   * Shared by smartFill (colour mask) and fillMaskRegion (arbitrary supplied mask).
   */
  function _dilateMask (mask, width, b, dilate) {
    dilate = dilate | 0
    if (dilate <= 0) return mask
    var fillMask = new Uint8Array(mask.length)
    var x, y, p, nx, ny, nx0, nx1, ny0, ny1, found
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        p = y * width + x
        if (mask[p]) { fillMask[p] = 1; continue }
        // Mark a fill target if any ORIGINAL mask pixel lies within Chebyshev radius `dilate`,
        // clamped to the region bounds (so dilation never reaches outside the region/image).
        ny0 = Math.max(b.y0, y - dilate); ny1 = Math.min(b.y1 - 1, y + dilate)
        nx0 = Math.max(b.x0, x - dilate); nx1 = Math.min(b.x1 - 1, x + dilate)
        found = false
        for (ny = ny0; ny <= ny1 && !found; ny++) {
          for (nx = nx0; nx <= nx1; nx++) {
            if (mask[ny * width + nx]) { found = true; break }
          }
        }
        if (found) fillMask[p] = 1
      }
    }
    return fillMask
  }

  /*
   * BFS / Fast-Marching geodesic fill core (T42) — the colour-agnostic reconstruction shared by
   * smartFill and fillMaskRegion. Reconstruct every pixel set in `fillMask` from the surrounding
   * background, processing in non-decreasing geodesic (8-connected) distance from the mask boundary,
   * estimating each pixel as the inverse-distance-weighted mean of its already-KNOWN neighbours.
   * Geodesic distance follows connected paths, so it never crosses a background gap (concave masks)
   * and always reaches corner/edge pixels (#32). A pixel is a colour SOURCE (known=1) if it is
   * in-region and NOT in fillMask (the dilated fringe is in fillMask, so excluded — CORE-8).
   * Mutates imageData.data IN PLACE.
   *
   * @returns {{skipped: boolean, unfilled: number, fillCount: number}} skipped:true when the #31
   *        maxFillRatio guard tripped (buffer left untouched, unfilled = fillCount). fillCount =
   *        total fill-set size; filled = fillCount - unfilled.
   */
  function _bfsFill (imageData, fillMask, b, maxFillRatio) {
    var data = imageData.data
    var width = imageData.width
    var n = width * imageData.height
    var x, y, p, o

    // 2. #31 guard. Count the fill set and bail if it covers almost the whole region: with that
    //    little background left there is nothing meaningful to sample, the result is garbage, and
    //    the O(area) work can stall the main thread long enough to corrupt a GPU frame (the stripe /
    //    glitch artifacts in #31). Default maxFillRatio = 1 (effectively off) keeps the unit tests
    //    deterministic; the GUI opts in with 0.8. `skipped` lets the caller warn + not paint.
    var regionArea = (b.x1 - b.x0) * (b.y1 - b.y0)
    var fillCount = 0
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) { if (fillMask[y * width + x]) fillCount++ }
    }
    var mfr = (typeof maxFillRatio === 'number') ? maxFillRatio : 1
    if (regionArea > 0 && fillCount / regionArea > mfr) {
      return { skipped: true, unfilled: fillCount, fillCount: fillCount }
    }

    // 3. BFS geodesic fill.
    var known = new Uint8Array(n)   // 1 = valid colour source (original bg OR an already-filled px)
    var queued = new Uint8Array(n)  // 1 = already placed in the queue (never enqueue twice)
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        p = y * width + x
        if (!fillMask[p]) known[p] = 1
      }
    }

    // FIFO queue of absolute pixel indices (p = y*width + x). Sized by region area — a safe upper
    // bound, since each fill pixel is enqueued at most once (the `queued` flag guards re-entry).
    // Do NOT size by fillCount (undersizes → silent index overrun) and do NOT use an Array
    // (`shift()` is O(n^2) — the perf trap behind #31). head/tail only advance; no wrap-around.
    var queue = new Uint32Array(regionArea)
    var head = 0, tail = 0
    var dx, dy, nxp, nyp, np

    // Seed the distance-1 layer: every fill pixel that touches an original-background source.
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        p = y * width + x
        if (!fillMask[p]) continue
        for (dy = -1; dy <= 1; dy++) {
          nyp = y + dy
          if (nyp < b.y0 || nyp >= b.y1) continue
          for (dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            nxp = x + dx
            if (nxp < b.x0 || nxp >= b.x1) continue
            if (known[nyp * width + nxp]) { queue[tail++] = p; queued[p] = 1; dy = 2; break }
          }
        }
      }
    }

    // Drain FIFO. BFS over unit (Chebyshev) edges dequeues in non-decreasing distance order, so the
    // fill propagates as a single monotonic front — no competing fronts, no seam. Each popped pixel
    // is guaranteed >=1 known neighbour (that is why it was enqueued), so wS > 0 always.
    var rS, gS, bS, wS, w
    while (head < tail) {
      p = queue[head++]
      x = p % width; y = (p / width) | 0
      rS = 0; gS = 0; bS = 0; wS = 0
      for (dy = -1; dy <= 1; dy++) {
        nyp = y + dy
        if (nyp < b.y0 || nyp >= b.y1) continue
        for (dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          nxp = x + dx
          if (nxp < b.x0 || nxp >= b.x1) continue
          np = nyp * width + nxp
          if (!known[np]) continue
          w = (dx !== 0 && dy !== 0) ? 0.70710678 : 1 // 1/d: orthogonal d=1, diagonal d=sqrt(2)
          o = np * 4
          rS += data[o] * w; gS += data[o + 1] * w; bS += data[o + 2] * w; wS += w
        }
      }
      o = p * 4
      data[o]     = Math.round(rS / wS)
      data[o + 1] = Math.round(gS / wS)
      data[o + 2] = Math.round(bS / wS)
      // alpha preserved (not written) — mirrors replaceColour's 3-element behaviour
      known[p] = 1 // intentional: distance-ordered BFS — a finalized pixel is a safe source for
      //              deeper pixels; this is what fills concave interiors / corners that have no
      //              original neighbour. Do NOT "fix" this back to original-only sampling — that
      //              reintroduces the unfilled corners of #32 (see CORE-8 addendum in LEARNINGS.md).

      // Enqueue the next distance layer: not-yet-queued fill neighbours of this pixel.
      for (dy = -1; dy <= 1; dy++) {
        nyp = y + dy
        if (nyp < b.y0 || nyp >= b.y1) continue
        for (dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          nxp = x + dx
          if (nxp < b.x0 || nxp >= b.x1) continue
          np = nyp * width + nxp
          if (fillMask[np] && !queued[np]) { queue[tail++] = np; queued[np] = 1 }
        }
      }
    }

    // Any fill pixel never enqueued had no path to a source (e.g. an all-target image, or a region
    // with no in-region background) — it stays at its original colour and is reported as unfilled.
    var unfilled = 0
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        p = y * width + x
        if (fillMask[p] && !queued[p]) unfilled++
      }
    }

    return { skipped: false, unfilled: unfilled, fillCount: fillCount }
  }

  /*
   * Inpaint an arbitrary supplied mask (T29 Phase 3 — tiled-watermark propagation fill).
   *
   * Unlike smartFill, the fill set is given DIRECTLY (e.g. propagateMask()'s union mask) rather than
   * derived from a target colour — so this path is colour-agnostic. Reuses the exact dilation (T30)
   * + #31 guard + BFS geodesic core (T42) as smartFill, via the shared _dilateMask / _bfsFill
   * internals, so a mask equal to smartFill's colour mask yields byte-identical pixels.
   *
   * @param {ImageData|{data,width,height}} imageData  RGBA buffer. Mutated IN PLACE.
   * @param {Uint8Array} mask  width*height; non-zero marks a pixel to reconstruct from background.
   * @param {object} [options]  `dilate` (default 0) — expand the mask before filling (anti-alias
   *        fringe); `maxFillRatio` (default 1 = off; the GUI passes 0.8) — skip + return skipped:true
   *        when the fill set exceeds this fraction of the region.
   * @param {object} [region]  optional {x,y,width,height}; omitted → whole image. The GUI passes null
   *        so the #31 guard denominator is the full image — correct for thin, sparse tiled strokes.
   * @returns {{imageData: ImageData, filled: number, unfilled: number, skipped?: boolean}}
   *        filled = pixels reconstructed (fill set minus unfilled). skipped:true → buffer untouched.
   */
  function fillMaskRegion (imageData, mask, options, region) {
    var width = imageData.width
    var height = imageData.height
    var b = clampRegion(region, width, height)
    var dilate = (options && options.dilate) | 0
    var maxFillRatio = (options && typeof options.maxFillRatio === 'number') ? options.maxFillRatio : 1
    var fillMask = _dilateMask(mask, width, b, dilate)
    var fr = _bfsFill(imageData, fillMask, b, maxFillRatio)
    if (fr.skipped) return { imageData: imageData, filled: 0, unfilled: fr.unfilled, skipped: true }
    return { imageData: imageData, filled: fr.fillCount - fr.unfilled, unfilled: fr.unfilled }
  }

  /*
   * Watermark detection (T29 Phase 2) — pure, dependency-free, Node-testable.
   *
   * Move from "remove this colour" to "find this kind of thing": locate text-shaped regions
   * automatically and return a binary mask + per-component metadata + a confidence score. This
   * slice does NOT apply any fill — the mask is surfaced (display-only overlay) for the user to
   * confirm; the confirm -> fill step lands with the T43 routing engine (#44).
   *
   * Pipeline (all bounded to the clamped region):
   *   1. Per-channel Sobel: run the Sobel kernel on R, G and B separately and take the MAX
   *      gradient magnitude across the three channels — not on luminance. Watermark edges often
   *      have strong per-channel colour separation even when luminance contrast is near zero
   *      (an iso-luminant colour overlay); a luminance-only pass would miss those and pick up
   *      background texture just as readily. Threshold -> binary edge map.
   *   2. Morphological close (dilate then erode, radius 1) to bridge glyph strokes into solid
   *      blobs so the mask covers the glyph body, not just its hollow outline. Implemented as
   *      two flat array passes through a scratch buffer (NOT per-pixel function calls) — this is
   *      the heaviest step (two O(W*H) 3x3 scans).
   *   3. Connected-component labelling via iterative 8-connected BFS (no recursion — a deep
   *      component would blow the call stack on a large image). Queue sized by region area
   *      (CORE-12): each pixel is enqueued at most once (visited guard), so that is a safe bound.
   *   4. Classify each component as text-like with the documented heuristics. Edge detection of a
   *      SOLID block yields a hollow ring, which would masquerade as thin "text" — so each
   *      component's interior holes are flood-filled first and the FILLED area drives the
   *      bbox-fill-ratio test. A solid block fills its bbox (rejected); letters do not (kept).
   *   5. Union the surviving components' (stroke) pixels into the output mask.
   *   6. Confidence in [0,1]: combine component count (saturating) with size regularity (low
   *      coefficient-of-variation of areas => a repeating watermark => high confidence).
   *
   * @param {ImageData|{data,width,height}} imageData  RGBA buffer. NOT mutated (read-only).
   * @param {object} [options]  edgeThreshold, minArea, maxAreaRatio, maxFillRatio,
   *        minPerimeterRatio, preContrast — see DETECT_DEFAULTS. Defaults keep tests
   *        deterministic; the GUI may tune without touching the engine. edgeThreshold MUST be
   *        calibrated on real fixtures (the default is a starting point, not a tuned value).
   * @param {object} [region]   Optional {x,y,width,height} in image px. Detection runs only
   *        inside the clamped rect (whole image when omitted).
   * @returns {{mask: Uint8Array, components: Array<{x0,y0,x1,y1,area,perimeter}>, confidence: number}}
   *        mask is full-image-sized (1 = watermark pixel). components are the PASSING (text-like)
   *        ones in image coords. confidence is in [0,1], reported but not thresholded here.
   */
  // ENGINE DEFAULTS are intentionally CONSERVATIVE/generic — the new levers (blurRadius, minAspect)
  // default to no-ops so option-less callers and the unit suite keep their existing behaviour.
  //
  // #45 calibration finding (scripts/calibrate-detect.js): edge-detection + static thresholds CANNOT
  // isolate a FAINT TILED watermark from photographic content. On the WhatsApp school-photo fixtures
  // neither preContrast setting works — pc=false's candidates land on faces/uniforms (mask 3-30%
  // light), pc=true's mask is 2-3% light (still photo edges; the watermark sits below the edge-noise
  // floor). It works only on a HIGH-CONTRAST watermark (watermark.jpg's pink text: mask 54% light).
  // The watermark's separable signal is its regular TILING -> frequency domain (FFT), tracked in a
  // follow-up ticket. The blurRadius/minAspect levers + harness remain as infrastructure for that work.
  var DETECT_DEFAULTS = {
    blurRadius: 0,         // Gaussian/box pre-pass before Sobel (0=none,1=3x3,2=5x5). Suppresses
                           // photo-texture high-freq noise so it falls below edgeThreshold (#45).
    edgeThreshold: 150,    // max-channel Sobel |gx|+|gy| (range ~0-2040).
    minArea: 10,           // px — reject sub-noise specks
    maxAreaRatio: 0.5,     // reject a component covering more than this fraction of the region
    maxFillRatio: 0.65,    // filled-area / bbox-area above this = solid block -> reject
    minPerimeterRatio: 0.3, // perimeter / area below this = chunky/solid -> reject
    minAspect: 0,          // require bbox width/height >= this. Watermark text spans wide bboxes;
                           // near-square blobs are texture. 0 = off (generic).
    preContrast: true      // default ON: invert+contrast (CORE-13) amplifies light/white watermarks
                           // to dark edges before Sobel. Grey-on-grey is the residual hard case
                           // (invert(grey)≈grey), but real-world watermarks are usually light.
  }

  // Per-value transform LUT. With preContrast it is the invert(1)+contrast(1.6) recipe proven in
  // Phase 1 (CORE-13); otherwise an identity table so the Sobel read stays branch-free.
  function buildLut (preContrast) {
    var lut = new Uint8Array(256)
    for (var v = 0; v < 256; v++) {
      if (!preContrast) { lut[v] = v; continue }
      var c = ((255 - v) - 128) * 1.6 + 128 // invert, then contrast about mid-grey
      lut[v] = c < 0 ? 0 : (c > 255 ? 255 : Math.round(c))
    }
    return lut
  }

  // Separable box blur over the RGB channels inside region `b`, radius `r` (window 2r+1). Returns a
  // fresh RGBA Uint8ClampedArray sized like `data` — only the region is meaningful, the rest is left
  // zero (the Sobel pass never reads outside `b`). Two passes (horizontal then vertical) via a scratch
  // buffer; sample counts are clamped to the region edges so border pixels normalise correctly.
  // Box blur approximates a Gaussian closely enough at these radii and is O(n) regardless of r (#45).
  function blurRegionRgb (data, width, b, r) {
    var out = new Uint8ClampedArray(data.length)
    var tmp = new Float32Array(data.length) // holds the horizontal-pass result (RGB only)
    var x, y, ch, k, o, count, sum
    // Horizontal pass: data -> tmp
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        o = (y * width + x) * 4
        for (ch = 0; ch < 3; ch++) {
          sum = 0; count = 0
          for (k = -r; k <= r; k++) {
            var sx = x + k
            if (sx < b.x0 || sx >= b.x1) continue
            sum += data[(y * width + sx) * 4 + ch]; count++
          }
          tmp[o + ch] = sum / count
        }
      }
    }
    // Vertical pass: tmp -> out
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        o = (y * width + x) * 4
        for (ch = 0; ch < 3; ch++) {
          sum = 0; count = 0
          for (k = -r; k <= r; k++) {
            var sy = y + k
            if (sy < b.y0 || sy >= b.y1) continue
            sum += tmp[(sy * width + x) * 4 + ch]; count++
          }
          out[o + ch] = Math.round(sum / count)
        }
      }
    }
    return out
  }

  function detectWatermark (imageData, options, region) {
    var data = imageData.data
    var width = imageData.width
    var height = imageData.height
    var n = width * height
    var b = clampRegion(region, width, height)
    var opt = options || {}
    var blurRadius = opt.blurRadius != null ? opt.blurRadius : DETECT_DEFAULTS.blurRadius
    var edgeThreshold = opt.edgeThreshold != null ? opt.edgeThreshold : DETECT_DEFAULTS.edgeThreshold
    var minArea = opt.minArea != null ? opt.minArea : DETECT_DEFAULTS.minArea
    var maxAreaRatio = opt.maxAreaRatio != null ? opt.maxAreaRatio : DETECT_DEFAULTS.maxAreaRatio
    var maxFillRatio = opt.maxFillRatio != null ? opt.maxFillRatio : DETECT_DEFAULTS.maxFillRatio
    var minPerimeterRatio = opt.minPerimeterRatio != null ? opt.minPerimeterRatio : DETECT_DEFAULTS.minPerimeterRatio
    var minAspect = opt.minAspect != null ? opt.minAspect : DETECT_DEFAULTS.minAspect
    // preContrast must fall back to the default like every other knob — `!!opt.preContrast` ignored
    // DETECT_DEFAULTS.preContrast, so the documented `default ON` never applied (engine + GUI ran raw
    // Sobel). Consult the default explicitly (#45).
    var preContrast = opt.preContrast != null ? opt.preContrast : DETECT_DEFAULTS.preContrast
    var lut = buildLut(!!preContrast)

    var regionArea = (b.x1 - b.x0) * (b.y1 - b.y0)
    var mask = new Uint8Array(n)
    if (regionArea <= 0) return { mask: mask, components: [], confidence: 0 }

    var x, y, p, dx, dy, nx, ny, ch

    // 0. Optional Gaussian/box pre-blur (#45). Sobel amplifies high frequencies, so smoothing first
    //    drops sub-pixel photo texture below threshold while leaving strong watermark edges. Runs on
    //    a working COPY of the RGB channels — `data` (the caller's buffer) stays read-only.
    var src = blurRadius > 0 ? blurRegionRgb(data, width, b, blurRadius) : data

    // 1. Per-channel Sobel -> edge map. Neighbours are clamped to the region (edge replication),
    //    so border pixels still get a gradient instead of a false zero.
    var edge = new Uint8Array(n)
    for (y = b.y0; y < b.y1; y++) {
      var ym1 = y > b.y0 ? y - 1 : b.y0
      var yp1 = y < b.y1 - 1 ? y + 1 : b.y1 - 1
      for (x = b.x0; x < b.x1; x++) {
        var xm1 = x > b.x0 ? x - 1 : b.x0
        var xp1 = x < b.x1 - 1 ? x + 1 : b.x1 - 1
        var oTL = (ym1 * width + xm1) * 4, oT = (ym1 * width + x) * 4, oTR = (ym1 * width + xp1) * 4
        var oL = (y * width + xm1) * 4, oR = (y * width + xp1) * 4
        var oBL = (yp1 * width + xm1) * 4, oB = (yp1 * width + x) * 4, oBR = (yp1 * width + xp1) * 4
        var maxMag = 0
        for (ch = 0; ch < 3; ch++) {
          var tl = lut[src[oTL + ch]], t = lut[src[oT + ch]], tr = lut[src[oTR + ch]]
          var l = lut[src[oL + ch]], r = lut[src[oR + ch]]
          var bl = lut[src[oBL + ch]], bb = lut[src[oB + ch]], br = lut[src[oBR + ch]]
          var gx = -tl - 2 * l - bl + tr + 2 * r + br
          var gy = -tl - 2 * t - tr + bl + 2 * bb + br
          var mag = (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy)
          if (mag > maxMag) maxMag = mag
        }
        if (maxMag >= edgeThreshold) edge[y * width + x] = 1
      }
    }

    // 2. Morphological close. Pass A dilates edge -> scratch (any 3x3 neighbour set); pass B
    //    erodes scratch -> closed (all in-bounds 3x3 neighbours set). Two flat passes, scratch
    //    buffer between them — never a per-pixel helper call.
    var scratch = new Uint8Array(n)
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        var any = 0
        for (dy = -1; dy <= 1 && !any; dy++) {
          ny = y + dy
          if (ny < b.y0 || ny >= b.y1) continue
          for (dx = -1; dx <= 1; dx++) {
            nx = x + dx
            if (nx < b.x0 || nx >= b.x1) continue
            if (edge[ny * width + nx]) { any = 1; break }
          }
        }
        if (any) scratch[y * width + x] = 1
      }
    }
    var closed = new Uint8Array(n)
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        var all = 1
        for (dy = -1; dy <= 1 && all; dy++) {
          ny = y + dy
          if (ny < b.y0 || ny >= b.y1) continue
          for (dx = -1; dx <= 1; dx++) {
            nx = x + dx
            if (nx < b.x0 || nx >= b.x1) continue
            if (!scratch[ny * width + nx]) { all = 0; break }
          }
        }
        if (all) closed[y * width + x] = 1
      }
    }

    // 3. Connected components (iterative 8-connected BFS). visited guards re-entry; the queue is
    //    sized by region area (a safe upper bound — see CORE-12). Pixels of each component are
    //    collected so steps 4-5 can hole-fill + union without a second labelling pass.
    var visited = new Uint8Array(n)
    var queue = new Uint32Array(regionArea)
    var components = []
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        p = y * width + x
        if (!closed[p] || visited[p]) continue
        var head = 0, tail = 0
        queue[tail++] = p; visited[p] = 1
        var area = 0, perim = 0
        var minx = x, maxx = x, miny = y, maxy = y
        var pixels = []
        while (head < tail) {
          var cp = queue[head++]
          var cx = cp % width, cy = (cp / width) | 0
          area++
          pixels.push(cp)
          if (cx < minx) minx = cx
          if (cx > maxx) maxx = cx
          if (cy < miny) miny = cy
          if (cy > maxy) maxy = cy
          // Perimeter: pixel touches the background on any 4-neighbour (or the region edge).
          if (cy - 1 < b.y0 || !closed[(cy - 1) * width + cx] ||
              cy + 1 >= b.y1 || !closed[(cy + 1) * width + cx] ||
              cx - 1 < b.x0 || !closed[cy * width + cx - 1] ||
              cx + 1 >= b.x1 || !closed[cy * width + cx + 1]) perim++
          for (dy = -1; dy <= 1; dy++) {
            ny = cy + dy
            if (ny < b.y0 || ny >= b.y1) continue
            for (dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue
              nx = cx + dx
              if (nx < b.x0 || nx >= b.x1) continue
              var np = ny * width + nx
              if (closed[np] && !visited[np]) { visited[np] = 1; queue[tail++] = np }
            }
          }
        }
        components.push({ x0: minx, y0: miny, x1: maxx, y1: maxy, area: area, perimeter: perim, pixels: pixels })
      }
    }

    // 4. Classify + 5. union mask. The FILLED area (component + enclosed holes) drives the
    //    bbox-fill-ratio so a hollow ring from a solid block reads as solid, not text.
    var passing = []
    for (var ci = 0; ci < components.length; ci++) {
      var c = components[ci]
      var bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1
      var bboxArea = bw * bh
      var aspect = bw / bh // watermark text spans wide bboxes; near-square blobs are texture (#45)
      var filledArea = fillHoles(c.pixels, width, c.x0, c.y0, bw, bh)
      var fillRatio = filledArea / bboxArea
      var perimRatio = c.area > 0 ? c.perimeter / c.area : 0
      var isText = c.area >= minArea &&
        (c.area / regionArea) <= maxAreaRatio &&
        fillRatio <= maxFillRatio &&
        perimRatio >= minPerimeterRatio &&
        aspect >= minAspect
      if (!isText) continue
      for (var pi = 0; pi < c.pixels.length; pi++) mask[c.pixels[pi]] = 1
      passing.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, area: c.area, perimeter: c.perimeter })
    }

    // 6. Confidence in [0,1]: count (saturating at 8) * size regularity (1 - clamped CoV of areas).
    var count = passing.length
    var confidence = 0
    if (count > 0) {
      var sum = 0
      for (var k = 0; k < count; k++) sum += passing[k].area
      var mean = sum / count
      var varSum = 0
      for (var k2 = 0; k2 < count; k2++) { var d = passing[k2].area - mean; varSum += d * d }
      var cov = mean > 0 ? Math.sqrt(varSum / count) / mean : 1
      var regularity = 1 - (cov > 1 ? 1 : cov)
      confidence = Math.min(count / 8, 1) * regularity
    }

    return { mask: mask, components: passing, confidence: confidence }
  }

  // Count the FILLED area of one component: its own pixels plus any background cells enclosed by
  // it. Works on a local bw*bh grid of the component's bbox: mark occupied cells, flood the
  // OUTSIDE inward from the bbox border (4-connected over empty cells), then filled = total minus
  // the cells the outside flood reached. A hollow ring (solid block's edge) fills to ~1.0; an open
  // letter shape barely fills at all.
  function fillHoles (pixels, width, ox, oy, bw, bh) {
    var size = bw * bh
    var occ = new Uint8Array(size)
    var i
    for (i = 0; i < pixels.length; i++) {
      var px = pixels[i] // absolute image pixel index -> local bbox coords
      var ax = px % width, ay = (px / width) | 0
      occ[(ay - oy) * bw + (ax - ox)] = 1
    }
    var outside = new Uint8Array(size)
    var stack = new Int32Array(size)
    var top = 0
    // Seed every empty border cell.
    var lx, ly
    for (lx = 0; lx < bw; lx++) {
      if (!occ[lx] && !outside[lx]) { outside[lx] = 1; stack[top++] = lx }
      var bidx = (bh - 1) * bw + lx
      if (!occ[bidx] && !outside[bidx]) { outside[bidx] = 1; stack[top++] = bidx }
    }
    for (ly = 0; ly < bh; ly++) {
      var lidx = ly * bw
      if (!occ[lidx] && !outside[lidx]) { outside[lidx] = 1; stack[top++] = lidx }
      var ridx = ly * bw + (bw - 1)
      if (!occ[ridx] && !outside[ridx]) { outside[ridx] = 1; stack[top++] = ridx }
    }
    var reached = 0
    while (top > 0) {
      var cidx = stack[--top]
      reached++
      var cxl = cidx % bw, cyl = (cidx / bw) | 0
      if (cxl > 0) { var w1 = cidx - 1; if (!occ[w1] && !outside[w1]) { outside[w1] = 1; stack[top++] = w1 } }
      if (cxl < bw - 1) { var e1 = cidx + 1; if (!occ[e1] && !outside[e1]) { outside[e1] = 1; stack[top++] = e1 } }
      if (cyl > 0) { var n1 = cidx - bw; if (!occ[n1] && !outside[n1]) { outside[n1] = 1; stack[top++] = n1 } }
      if (cyl < bh - 1) { var s1 = cidx + bw; if (!occ[s1] && !outside[s1]) { outside[s1] = 1; stack[top++] = s1 } }
    }
    return size - reached
  }

  // =============================================================================================
  // detectTiling (#50, T29 Phase 2d) — frequency-domain tiled-watermark detector.
  //
  // detectWatermark (above) cannot isolate a FAINT TILED watermark from photographic content —
  // the watermark sits below the spatial edge-noise floor (LEARNINGS CORE-16). The only separable
  // signal is its regular TILING: a periodic overlay autocorrelates as a harmonic COMB of peaks at
  // k*fundamental along the tile direction. This block is a production port of the #49 spike
  // (scripts/spike-fft-tiling-2.js), which proved the recipe
  //     log1p -> high-pass -> LCN -> Hann -> autocorrelation -> comb-count gate
  // lifts the WhatsApp class-photo targets from 2.6-2.8x (MARGINAL) to clean 5-10 peak combs.
  //
  // CRITICAL: gate on COMB COUNT (>= COMB_MIN collinear harmonics), NOT top-ratio. Pre-processing
  // inflates the top peak/floor ratio for EVERYTHING, including clean photos (CORE-16 #49 addendum)
  // — only the comb still separates real tiling from photo texture.
  //
  // Detection thresholds below are frozen at the spike's proven values; do NOT tune without new
  // fixture evidence. RBIG is swept (issue #50 constraint #3) because a single high-pass radius
  // attenuates tile periods near/above it — small/medium periods survive RBIG=48, the ~87px diagonal
  // does not, so we try {32,64,128} and keep the strongest comb.
  var TILING = {
    LAG_MIN: 10,        // exclude the central zero-lag lobe (broad photo autocorrelation)
    LAG_MAX_CAP: 200,   // largest tile period we bother with (few reps -> unreliable beyond)
    COMB_RATIO: 2.5,    // a peak must clear this peak/floor ratio to join the harmonic-comb tally
    COMB_MIN: 5,        // >= this many collinear harmonics (k*fundamental) == a real tiling comb
    JPEG_LAG: 8,        // JPEG 8x8 DCT block period -> AC peak at lag 8 (a fundamental at/below
                        // JPEG_LAG+2 is the compression grid, not a watermark)
    TOP_N: 12,          // peaks to keep
    MIN_BASIS_ANGLE_COS: 0.5, // #46: a second lattice basis vector must be >= 60deg off the
                        // fundamental (|cos| < this) to count as a genuinely different direction
                        // rather than a higher harmonic of the same axis. TUNABLE — a shallow-angle
                        // diagonal tiling could have two real basis vectors that are near-collinear;
                        // raise toward 1 (allow smaller separations) only with diagonal-fixture evidence.
    RMED: 16,           // LCN local-magnitude blur radius (fixed structural choice)
    BLUR_PASSES: 3,     // box-blur passes -> Gaussian approximation
    RBIG_SWEEP: [32, 64, 128], // high-pass radii to try (filtered to <= N/2 at call time)
    N_CAP: 512,         // analysis window cap (largest po2 we analyse)
    N_FLOOR: 64         // below this a >=4-harmonic comb cannot fit the annulus
  }

  // Largest power-of-2 <= v.
  function po2Floor (v) {
    var p = 1
    while (p * 2 <= v) p *= 2
    return p
  }

  // 1D radix-2 iterative FFT (in place); inverse = conjugate twiddle, caller divides by n. Ported
  // verbatim from the spike (operates on re.length, so it is already N-agnostic).
  function fft (re, im, inverse) {
    var n = re.length
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1
      for (; j & bit; bit >>= 1) j ^= bit
      j ^= bit
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr
        var ti = im[i]; im[i] = im[j]; im[j] = ti
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = (inverse ? 2 : -2) * Math.PI / len
      var wr = Math.cos(ang), wi = Math.sin(ang)
      for (var s = 0; s < n; s += len) {
        var cwr = 1, cwi = 0, half = len >> 1
        for (var k = 0; k < half; k++) {
          var a = s + k, b = s + k + half
          var xr = re[b] * cwr - im[b] * cwi
          var xi = re[b] * cwi + im[b] * cwr
          re[b] = re[a] - xr; im[b] = im[a] - xi
          re[a] = re[a] + xr; im[a] = im[a] + xi
          var ncwr = cwr * wr - cwi * wi
          cwi = cwr * wi + cwi * wr
          cwr = ncwr
        }
      }
    }
  }

  // 2D FFT over NxN planes: transform every row then every column. `lineRe`/`lineIm` are caller-
  // supplied length-N scratch (pre-allocated once — GC note in the dev plan). Inverse divides by N*N.
  function fft2 (re, im, inverse, N, lineRe, lineIm) {
    var x, y
    for (y = 0; y < N; y++) {
      var off = y * N
      for (x = 0; x < N; x++) { lineRe[x] = re[off + x]; lineIm[x] = im[off + x] }
      fft(lineRe, lineIm, inverse)
      for (x = 0; x < N; x++) { re[off + x] = lineRe[x]; im[off + x] = lineIm[x] }
    }
    for (x = 0; x < N; x++) {
      for (y = 0; y < N; y++) { lineRe[y] = re[y * N + x]; lineIm[y] = im[y * N + x] }
      fft(lineRe, lineIm, inverse)
      for (y = 0; y < N; y++) { re[y * N + x] = lineRe[y]; im[y * N + x] = lineIm[y] }
    }
    if (inverse) { var s = 1 / (N * N); for (var i = 0; i < N * N; i++) { re[i] *= s; im[i] *= s } }
  }

  // Centred NxN luminance crop (edge-clamped). Reads imageData.data (RGBA) directly. `region`
  // (clamped {x,y,width,height}) recentres the window; default = image centre.
  function lumaWindow (imageData, N, region) {
    var data = imageData.data, W = imageData.width, H = imageData.height
    var cx, cy
    if (region) { cx = region.x + region.width / 2; cy = region.y + region.height / 2 }
    else { cx = W / 2; cy = H / 2 }
    var ox = Math.floor(cx - N / 2), oy = Math.floor(cy - N / 2)
    var out = new Float64Array(N * N)
    for (var y = 0; y < N; y++) {
      var sy = Math.min(H - 1, Math.max(0, oy + y))
      for (var x = 0; x < N; x++) {
        var sx = Math.min(W - 1, Math.max(0, ox + x))
        var o = (sy * W + sx) * 4
        out[y * N + x] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
      }
    }
    return out
  }

  // Separable box blur, BLUR_PASSES passes (~Gaussian), edge-clamped, over the NxN plane. Allocation-
  // free: copies `src` into `out` and uses `tmp` as the horizontal-pass scratch; result ends in `out`.
  function boxBlur (src, r, N, out, tmp) {
    var i
    for (i = 0; i < N * N; i++) out[i] = src[i]
    var win = 2 * r + 1, pass, x, y
    for (pass = 0; pass < TILING.BLUR_PASSES; pass++) {
      for (y = 0; y < N; y++) {                       // horizontal: out -> tmp
        var off = y * N, sum = 0, k, ii
        for (k = -r; k <= r; k++) { ii = k < 0 ? 0 : (k >= N ? N - 1 : k); sum += out[off + ii] }
        for (x = 0; x < N; x++) {
          tmp[off + x] = sum / win
          var rem = x - r; rem = rem < 0 ? 0 : rem
          var add = x + r + 1; add = add >= N ? N - 1 : add
          sum += out[off + add] - out[off + rem]
        }
      }
      for (x = 0; x < N; x++) {                        // vertical: tmp -> out
        var sum2 = 0, k2, jj
        for (k2 = -r; k2 <= r; k2++) { jj = k2 < 0 ? 0 : (k2 >= N ? N - 1 : k2); sum2 += tmp[jj * N + x] }
        for (y = 0; y < N; y++) {
          out[y * N + x] = sum2 / win
          var rem2 = y - r; rem2 = rem2 < 0 ? 0 : rem2
          var add2 = y + r + 1; add2 = add2 >= N ? N - 1 : add2
          sum2 += tmp[add2 * N + x] - tmp[rem2 * N + x]
        }
      }
    }
  }

  // The #49 GO recipe (in mandated order — constraint #2): log1p on RAW positive luma FIRST, then
  // high-pass (subtract blur, radius rbig), then LCN (divide by blurred local magnitude, RMED). Writes
  // the result into pool.work and returns it. Uses pool.blur + pool.tmp as blur scratch, pool.mag for
  // the LCN magnitude — all pre-allocated, so the 3-radius sweep allocates nothing per iteration.
  function preprocess (luma, rbig, N, pool) {
    var work = pool.work, i
    for (i = 0; i < N * N; i++) work[i] = Math.log1p(luma[i])         // log1p (raw positive luma)
    boxBlur(work, rbig, N, pool.blur, pool.tmp)                       // high-pass: subtract blur
    for (i = 0; i < N * N; i++) work[i] = work[i] - pool.blur[i]
    var mag = pool.mag, meanMag = 0                                   // LCN
    for (i = 0; i < N * N; i++) { mag[i] = Math.abs(work[i]); meanMag += mag[i] }
    meanMag /= mag.length
    boxBlur(mag, TILING.RMED, N, pool.blur, pool.tmp)                 // local magnitude -> pool.blur
    var eps = 1e-3 * meanMag + 1e-9                                   // numerical floor, NOT a threshold
    for (i = 0; i < N * N; i++) work[i] = work[i] / (pool.blur[i] + eps)
    return work
  }

  // Detrend (subtract mean) + separable 2D Hann window to suppress crop-edge spectral leakage. Writes
  // into pool.windowed (a dedicated plane so autocorrelation can copy from it without clobbering work).
  function detrendHann (luma, N, pool) {
    var mean = 0, i
    for (i = 0; i < N * N; i++) mean += luma[i]
    mean /= N * N
    var hann = pool.hann
    for (i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)))
    var out = pool.windowed
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) out[y * N + x] = (luma[y * N + x] - mean) * hann[y] * hann[x]
    return out
  }

  // AC = IFFT(|FFT(windowed)|^2). Returns the DC(zero-lag)-centred real autocorrelation in pool.ac,
  // normalised so zero-lag = 1. (The spike also returned the shifted power spectrum for PNG evidence;
  // the engine drops it — nothing reads it here.)
  function autocorrelation (windowed, N, pool) {
    var re = pool.re, im = pool.im, i
    for (i = 0; i < N * N; i++) { re[i] = windowed[i]; im[i] = 0 }
    fft2(re, im, false, N, pool.lineRe, pool.lineIm)
    for (i = 0; i < N * N; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0 } // power spectrum
    fft2(re, im, true, N, pool.lineRe, pool.lineIm) // inverse -> circular autocorrelation, zero-lag [0,0]
    var ac = pool.ac, zero = re[0] || 1
    for (var y = 0; y < N; y++) {
      var sy = (y + N / 2) % N
      for (var x = 0; x < N; x++) {
        var sx = (x + N / 2) % N
        ac[sy * N + sx] = re[y * N + x] / zero // normalise zero-lag -> 1, centre the lattice
      }
    }
    return ac
  }

  function median (arr) {
    var a = Float64Array.from(arr).sort()
    var n = a.length
    return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2])
  }

  // Strongest secondary AC peaks (3x3 local maxima) in the lag annulus [LAG_MIN, lagMax], upper
  // half-plane (each physical lag once). Returns the TOP_N peaks ranked by AC value + the local AC
  // noise floor (median over the annulus).
  function acPeaks (ac, N, lagMax) {
    var cy = N / 2, cx = N / 2, vals = [], peaks = [], lagMin = TILING.LAG_MIN
    for (var y = 1; y < N - 1; y++) {
      var dy = y - cy
      for (var x = 1; x < N - 1; x++) {
        var dx = x - cx, r2 = dx * dx + dy * dy
        if (r2 < lagMin * lagMin || r2 > lagMax * lagMax) continue
        vals.push(Math.abs(ac[y * N + x]))
        if (dy < 0 || (dy === 0 && dx <= 0)) continue // upper half-plane dedupe
        var v = ac[y * N + x]
        if (v < ac[(y - 1) * N + x] || v < ac[(y + 1) * N + x] ||
            v < ac[y * N + x - 1] || v < ac[y * N + x + 1] ||
            v < ac[(y - 1) * N + x - 1] || v < ac[(y - 1) * N + x + 1] ||
            v < ac[(y + 1) * N + x - 1] || v < ac[(y + 1) * N + x + 1]) continue
        peaks.push({ lx: dx, ly: dy, v: v })
      }
    }
    var floor = median(vals) || 1e-9
    peaks.sort(function (a, b) { return b.v - a.v })
    return { peaks: peaks.slice(0, TILING.TOP_N), floor: floor }
  }

  // HARMONIC-COMB SCORE — the key signal. Take the smallest-lag strong peak as the fundamental, then
  // count strong peaks whose lag is (a) a near-integer multiple of the fundamental AND (b) roughly
  // collinear with it. >= COMB_MIN such peaks == real tiling.
  //
  // #46 also extracts the lattice basis for mask propagation: `fund` is the primary tile vector, and
  // `basis2` is the STRONGEST strong peak that is NOT collinear with `fund` (>= MIN_BASIS_ANGLE_COS off
  // axis) — the second grid direction, or null for a 1-D tiling. `strong` is in descending-AC order
  // (acPeaks sorts by value), so the first non-collinear hit is the strongest second-direction peak.
  // Note: basis2 is for EXTRACTION only and does not affect `count`/the comb gate — the gate stays a
  // single-direction collinear comb, so this change cannot move existing tiling verdicts.
  function combScore (peaks, floor, ratio) {
    var strong = peaks.filter(function (p) { return p.v / floor >= ratio })
    if (!strong.length) return { count: 0, fund: null, fr: 0, basis2: null }
    var fund = strong[0]
    for (var i = 1; i < strong.length; i++) {
      if (Math.hypot(strong[i].lx, strong[i].ly) < Math.hypot(fund.lx, fund.ly)) fund = strong[i]
    }
    var fr = Math.hypot(fund.lx, fund.ly) || 1
    var dirx = fund.lx / fr, diry = fund.ly / fr, count = 0
    var basis2 = null
    for (var p = 0; p < strong.length; p++) {
      var r = Math.hypot(strong[p].lx, strong[p].ly)
      var k = r / fr
      var collinear = Math.abs((strong[p].lx * dirx + strong[p].ly * diry) / r)
      if (Math.abs(k - Math.round(k)) <= 0.2 && collinear > 0.85) count++
      if (basis2 === null && r > 0 && collinear < TILING.MIN_BASIS_ANGLE_COS) basis2 = strong[p]
    }
    return { count: count, fund: fund, fr: fr, basis2: basis2 }
  }

  /**
   * detectTiling — does this image contain a periodic TILED watermark?
   *
   * Frequency-domain detector (see the block comment above). Pure + Node-testable: reads
   * imageData.data, allocates only its own scratch, mutates nothing. Gates on harmonic-comb count.
   *
   * PERF: a 512x512 2D FFT swept over 3 high-pass radii is heavy (~hundreds of ms in-browser). This
   * is a DELIBERATE on-demand call — never run it live/per-frame (Web-Worker offload is backlog #43).
   *
   * @param {ImageData|{data,width,height}} imageData  RGBA buffer. NOT mutated (read-only).
   * @param {object} [options]  region: optional {x,y,width,height} to recentre the analysis window.
   * @returns {{tiling:boolean, period:number, combCount:number, topRatio:number,
   *            confidence:number, rbig:number, tileBasis:Array<{x:number,y:number}>}}
   *        tiling is the contract. period = fundamental lag (px). combCount = collinear harmonics at
   *        the winning radius. topRatio = strongest AC peak/floor (DIAGNOSTIC ONLY — not the gate).
   *        confidence in [0,1]. rbig = winning high-pass radius (NOT a spatial scale).
   *        tileBasis (#46) = lattice basis vectors in IMAGE-PIXEL offsets, ready as propagateMask
   *        translation vectors: [primary] for a 1-D tiling, [primary, secondary] for a 2-D grid, or []
   *        when no periodic peak was found. Each vector is sign-normalised into a canonical half-plane
   *        so stamping is deterministic. Surfaced regardless of the `tiling` gate (a caller propagates
   *        only when it trusts `tiling`); |tileBasis[0]| ~= period.
   */
  function detectTiling (imageData, options) {
    var opt = options || {}
    var region = opt.region ? clampRegion(opt.region, imageData.width, imageData.height) : null
    var avail = region ? Math.min(region.width, region.height) : Math.min(imageData.width, imageData.height)
    var N = po2Floor(Math.min(avail, TILING.N_CAP))
    var empty = { tiling: false, period: 0, combCount: 0, topRatio: 0, confidence: 0, rbig: 0, tileBasis: [], combMin: TILING.COMB_MIN }
    if (N < TILING.N_FLOOR) return empty // too small to host a >=4-harmonic comb

    var lagMax = Math.min(TILING.LAG_MAX_CAP, N / 2 - 2)
    var base = lumaWindow(imageData, N, region)
    // Pre-allocate the scratch pool ONCE (dev-plan GC note): the radius sweep reuses these planes —
    // it must NOT allocate Float64Array(N*N) per iteration.
    var pool = {
      work: new Float64Array(N * N), blur: new Float64Array(N * N), tmp: new Float64Array(N * N),
      mag: new Float64Array(N * N), windowed: new Float64Array(N * N),
      re: new Float64Array(N * N), im: new Float64Array(N * N), ac: new Float64Array(N * N),
      lineRe: new Float64Array(N), lineIm: new Float64Array(N), hann: new Float64Array(N)
    }

    // Sweep the high-pass radii (<= N/2) and keep the best result. "Best" prefers a TILING-valid
    // result (so a real comb at one radius is not masked by a higher-count JPEG-grid comb at another),
    // then higher comb count, then higher top-ratio.
    var radii = TILING.RBIG_SWEEP.filter(function (r) { return r <= N / 2 })
    if (!radii.length) radii = [Math.max(8, Math.floor(N / 4))] // tiny window fallback
    var best = null
    for (var ri = 0; ri < radii.length; ri++) {
      var windowed = detrendHann(preprocess(base, radii[ri], N, pool), N, pool)
      var ac = autocorrelation(windowed, N, pool)
      var pk = acPeaks(ac, N, lagMax)
      var comb = combScore(pk.peaks, pk.floor, TILING.COMB_RATIO)
      var fundLag = comb.fund ? Math.round(comb.fr) : 0
      var cleanScale = fundLag > TILING.JPEG_LAG + 2 // reject the JPEG 8px grid
      var topRatio = pk.peaks.length ? pk.peaks[0].v / pk.floor : 0
      var m = {
        tiling: comb.count >= TILING.COMB_MIN && cleanScale,
        period: fundLag, combCount: comb.count, topRatio: topRatio, rbig: radii[ri],
        fund: comb.fund, basis2: comb.basis2 // #46: carried for tileBasis; stripped before return
      }
      if (best === null ||
          (m.tiling && !best.tiling) ||
          (m.tiling === best.tiling && m.combCount > best.combCount) ||
          (m.tiling === best.tiling && m.combCount === best.combCount && m.topRatio > best.topRatio)) {
        best = m
      }
    }

    // confidence: ~0.17 at the gate (COMB_MIN), saturating to 1 at ~10 combs. Uses COMB_MIN-1 as the
    // zero anchor (one below the gate) so the confidence is non-zero for any tiling:true result.
    // Zeroed when not tiling (mirrors detectWatermark's [0,1] convention).
    best.confidence = best.tiling
      ? Math.max(0, Math.min((best.combCount - TILING.COMB_MIN + 1) / (10 - TILING.COMB_MIN + 1), 1)) : 0
    best.combMin = TILING.COMB_MIN // single source of truth for the gate (app.js reads t.combMin, no magic 5)

    // #46: build the image-pixel lattice basis from the winning radius's fundamental + 2nd vector, sign-
    // normalised into a canonical half-plane (x > 0, or x == 0 && y > 0) so a symmetric lattice always
    // yields the same stamping direction. Strip the raw peak refs so the return shape stays clean.
    best.tileBasis = []
    if (best.fund) best.tileBasis.push(canonicalBasis(best.fund.lx, best.fund.ly))
    if (best.basis2) best.tileBasis.push(canonicalBasis(best.basis2.lx, best.basis2.ly))
    delete best.fund
    delete best.basis2
    return best
  }

  // Sign-normalise a lag vector into the canonical half-plane (x > 0, or x == 0 && y > 0). The AC
  // lattice is symmetric (a peak at (lx,ly) implies one at (-lx,-ly)), so without a fixed sign the
  // stamping direction would be ambiguous. #46.
  function canonicalBasis (lx, ly) {
    if (lx > 0 || (lx === 0 && ly > 0)) return { x: lx, y: ly }
    return { x: -lx, y: -ly }
  }

  // =============================================================================================
  // detectTextTiling (#53, T29 follow-up) — template-matching (fast NCC) detector for LETTER-FORM
  // tiled watermarks (e.g. "TAYLOR GALE") that the FFT comb (detectTiling) misses: letter shapes
  // scatter energy across competing AC peaks with no dominant stripe axis, so combCount stays below
  // the gate. Here the user's boxed instance IS the template; normalised cross-correlation against
  // the whole frame finds its repeated echoes, and a nearest-neighbour pitch analysis yields a
  // lattice basis compatible with propagateMask().
  //
  // Ported from the validated spike scripts/spike-text-tiling.js (GO, 2026-06-30): NCC cutoff 0.5,
  // anisotropic NMS (CORE-20), template-footprint normalisation window, EPS NaN guard, >=3-peak /
  // >=0.5-score lattice gate. Wired as the runTile() fallback when detectTiling().combCount <
  // combMin — an ADDITIONAL mode, NOT a replacement for the stripe-comb path (#53).
  // =============================================================================================
  var TEXT_TILING = {
    WORK_MAX: 1024,       // downscale longest side to <= this before the 2-D FFT (cheap, ample for glyphs)
    NCC_CUTOFF: 0.5,      // spike-validated: targets latch a >=3 lattice, all negatives stay below
    EPS: 1e-10,           // denominator floor — flat template/region -> 0, never NaN (the NCC killer)
    MIN_PEAKS: 3,         // lattice gate: >= this many instances...
    MIN_SCORE: 0.5,       // ...AND >= this fraction of peaks sharing the dominant pitch
    PITCH_TOL_MAG: 0.18,  // a NN offset joins the dominant pitch if its magnitude is within this...
    PITCH_TOL_DEG: 18,    // ...fraction AND its direction within this many degrees of the median NN
    V1_MIN_DEG: 20,       // a 2nd basis vector must be > this many deg off v0 (genuinely non-collinear)...
    V1_MIN_SUPPORT: 2,    // ...AND shared by >= this many peaks, else omit v1 -> 1-D basis (#53 plan)
    MIN_TEMPLATE: 4,      // template < this px on either axis -> too small for NCC, return empty
    // #58 GLOBAL LATTICE FIT params (spike-validated hand-off, scripts/evidence/spike-lattice-58/results.txt).
    // Replaces the seed-local NN v1 heuristic with a fit over the WHOLE peak cloud -> position-invariant.
    INLIER_CUT: 0.65,     // fit the lattice on peaks with NCC >= this (true repeats), not cross-matches
    MIN_SUPPORT_FRAC: 0.15, // a candidate offset must recur across >= this fraction of inlier peak pairs
    DRIFT_FRAC: 0.12,     // 2-D drift tolerance = max(DRIFT_ABS, this * |v0|)
    DRIFT_ABS: 6,         // ...floor in px, for short pitches
    EXPLAIN_MIN: 0.6,     // >= this fraction of inlier peaks must land on a predicted lattice node
    OFFSET_TOL: 4,        // bucket width (px) when clustering difference vectors into candidate offsets
    GAUSS_CAP: 20         // cap on Lagrange-Gauss reduction iterations (near-collinear inputs can spin)
  }

  // Smallest power of two >= v (the spike's pad-up; po2Floor above is for the comb's window cap).
  function po2Ceil (v) { var p = 1; while (p < v) p *= 2; return p }

  // Full-image Rec.601 luminance at native resolution. Distinct from lumaWindow (a centred NxN crop):
  // NCC needs the whole frame. Only used on the scale==1 path; large frames take the downscale path.
  function fullLuma (imageData) {
    var data = imageData.data, n = imageData.width * imageData.height, luma = new Float64Array(n)
    for (var i = 0; i < n; i++) { var o = i * 4; luma[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] }
    return luma
  }

  // Area-average RGBA -> luma straight into a (dw x dh) working plane. Folds the downscale into the
  // luma extraction so a huge frame never materialises a full-res Float64 luma intermediate. Area
  // (not nearest) averaging keeps faint watermark strokes alive through the shrink.
  function downscaleToLuma (imageData, dw, dh) {
    var data = imageData.data, W = imageData.width, H = imageData.height, out = new Float64Array(dw * dh)
    for (var y = 0; y < dh; y++) {
      var sy0 = Math.floor(y * H / dh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * H / dh))
      for (var x = 0; x < dw; x++) {
        var sx0 = Math.floor(x * W / dw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * W / dw))
        var sum = 0, cnt = 0
        for (var sy = sy0; sy < sy1 && sy < H; sy++) {
          var row = sy * W
          for (var sx = sx0; sx < sx1 && sx < W; sx++) {
            var o = (row + sx) * 4
            sum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]; cnt++
          }
        }
        out[y * dw + x] = cnt ? sum / cnt : 0
      }
    }
    return out
  }

  // Summed-area tables (luma and luma^2) for the local image-energy denominator. Ported from spike.
  // sat[(y+1)*(W+1)+(x+1)] = sum of luma over [0..x] x [0..y].
  function buildSAT (luma, W, H) {
    var sat = new Float64Array((W + 1) * (H + 1)), sat2 = new Float64Array((W + 1) * (H + 1))
    for (var y = 0; y < H; y++) {
      var rowSum = 0, rowSum2 = 0
      for (var x = 0; x < W; x++) {
        var v = luma[y * W + x]
        rowSum += v; rowSum2 += v * v
        var idx = (y + 1) * (W + 1) + (x + 1)
        sat[idx] = sat[y * (W + 1) + (x + 1)] + rowSum
        sat2[idx] = sat2[y * (W + 1) + (x + 1)] + rowSum2
      }
    }
    return { sat: sat, sat2: sat2 }
  }
  function winSum (sat, W, u, v, tw, th) {
    var s = W + 1
    return sat[(v + th) * s + (u + tw)] - sat[v * s + (u + tw)] - sat[(v + th) * s + u] + sat[v * s + u]
  }

  // Fast normalised cross-correlation (Lewis 1995). Returns { ncc, tw, th, validW, validH, W }.
  // CIRCULAR-WRAP GUARD (#53 plan): pad to N = po2Ceil(max(W,H)) and define NCC ONLY over the
  // full-overlap valid region u in [0,W-tw], v in [0,H-th]. Every accessed offset u+x <= W-1 < N, so
  // no offset wraps and no partial-overlap window ever reaches the denominator. Do NOT shrink N below
  // max(W,H), and do NOT read NCC past the valid region — either reintroduces border false peaks.
  function fastNCC (luma, W, H, bbox) {
    var tw = bbox.x1 - bbox.x0, th = bbox.y1 - bbox.y0
    var N = po2Ceil(Math.max(W, H))
    var lineRe = new Float64Array(N), lineIm = new Float64Array(N), ty, tx, k

    // Zero-mean template + its energy.
    var meanT = 0
    for (ty = 0; ty < th; ty++) for (tx = 0; tx < tw; tx++) meanT += luma[(bbox.y0 + ty) * W + (bbox.x0 + tx)]
    meanT /= (tw * th)
    var tPad = new Float64Array(N * N), tIm = new Float64Array(N * N), energyT = 0
    for (ty = 0; ty < th; ty++) for (tx = 0; tx < tw; tx++) {
      var tv = luma[(bbox.y0 + ty) * W + (bbox.x0 + tx)] - meanT
      tPad[ty * N + tx] = tv; energyT += tv * tv
    }

    // Image plane (zero-padded into the NxN top-left).
    var iPad = new Float64Array(N * N), iIm = new Float64Array(N * N)
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) iPad[y * N + x] = luma[y * W + x]

    // Numerator = IFFT( FFT(I) . conj(FFT(T')) ).  c(u,v) = sum I(u+x,v+y) T'(x,y).
    fft2(iPad, iIm, false, N, lineRe, lineIm)
    fft2(tPad, tIm, false, N, lineRe, lineIm)
    var cRe = new Float64Array(N * N), cIm = new Float64Array(N * N)
    for (k = 0; k < N * N; k++) {
      var a = iPad[k], b = iIm[k], c = tPad[k], dd = tIm[k] // I * conj(T): (a+bi)(c-di)
      cRe[k] = a * c + b * dd
      cIm[k] = b * c - a * dd
    }
    fft2(cRe, cIm, true, N, lineRe, lineIm) // cRe[v*N+u] = numerator(u,v)

    // Denominator via SAT; assemble NCC over the valid region.
    var S = buildSAT(luma, W, H)
    var ncc = new Float64Array(W * H)
    var n = tw * th, validW = W - tw, validH = H - th, sqrtET = Math.sqrt(energyT)
    for (var v = 0; v <= validH; v++) {
      for (var u = 0; u <= validW; u++) {
        var sum = winSum(S.sat, W, u, v, tw, th)
        var sum2 = winSum(S.sat2, W, u, v, tw, th)
        var energyI = sum2 - (sum * sum) / n // sum of squared deviations in the window
        if (energyI < 0) energyI = 0
        var denom = Math.sqrt(energyI) * sqrtET
        if (denom < TEXT_TILING.EPS) denom = TEXT_TILING.EPS // flat region/template guard (no NaN)
        var val = cRe[v * N + u] / denom
        if (val > 1) val = 1; else if (val < -1) val = -1
        ncc[v * W + u] = val
      }
    }
    return { ncc: ncc, tw: tw, th: th, validW: validW, validH: validH, W: W }
  }

  // Peaks = 3x3 local maxima above NCC_CUTOFF, then ANISOTROPIC NMS (dx<tw AND dy<th, per-axis) so
  // the SHORT axis of a wide-short text template is not over-suppressed (CORE-20 — isotropic max(tw,th)
  // collapsed TAYLOR GALE's 5 rows to 2). Peaks stored at the template CENTRE. The 1px border skip
  // keeps the 3x3 test in-bounds and is the partial-overlap exclusion the wrap guard relies on.
  function extractTextPeaks (res, cutoff) {
    var W = res.W, ncc = res.ncc, tw = res.tw, th = res.th, cand = []
    for (var v = 1; v < res.validH; v++) {
      for (var u = 1; u < res.validW; u++) {
        var val = ncc[v * W + u]
        if (val < cutoff) continue
        if (val < ncc[v * W + u - 1] || val < ncc[v * W + u + 1] ||
            val < ncc[(v - 1) * W + u] || val < ncc[(v + 1) * W + u] ||
            val < ncc[(v - 1) * W + u - 1] || val < ncc[(v - 1) * W + u + 1] ||
            val < ncc[(v + 1) * W + u - 1] || val < ncc[(v + 1) * W + u + 1]) continue
        cand.push({ x: u + (tw >> 1), y: v + (th >> 1), v: val }) // peak at template centre
      }
    }
    cand.sort(function (a, b) { return b.v - a.v })
    var kept = []
    for (var i = 0; i < cand.length; i++) {
      var ok = true
      for (var j = 0; j < kept.length; j++) {
        if (Math.abs(cand[i].x - kept[j].x) < tw && Math.abs(cand[i].y - kept[j].y) < th) { ok = false; break }
      }
      if (ok) kept.push(cand[i])
    }
    return kept
  }

  // =============================================================================================
  // #58 GLOBAL LATTICE FIT — ported verbatim from the validated spike (scripts/spike-lattice-fit-58.js,
  // GO 2026-07-01) to replace the old seed-local NN `v1` heuristic. Position-invariant: reads every
  // peak PAIR in the cloud (not just each peak's nearest neighbour), so the fitted basis no longer
  // depends on which instance the user boxed. See LEARNINGS CORE-22 for the drift-gate rationale.
  // =============================================================================================
  function vdot (a, b) { return a.x * b.x + a.y * b.y }
  function vmag (a) { return Math.hypot(a.x, a.y) }
  function vcross (a, b) { return a.x * b.y - a.y * b.x }

  // Supported lattice translation vectors from the FULL peak cloud. A primitive lattice vector recurs
  // O(N) times across peak pairs; a spurious diff recurs ~once. Canonicalised to the +x half-plane and
  // averaged within an OFFSET_TOL bucket.
  function supportedOffsets (peaks, tol) {
    var map = {}
    for (var i = 0; i < peaks.length; i++) {
      for (var j = 0; j < peaks.length; j++) {
        if (i === j) continue
        var dx = peaks[j].x - peaks[i].x, dy = peaks[j].y - peaks[i].y
        if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy } // canonical +x half-plane
        if (Math.hypot(dx, dy) < tol) continue // skip near-zero (self / NMS residue)
        var key = Math.round(dx / tol) + ',' + Math.round(dy / tol)
        if (!map[key]) map[key] = { x: 0, y: 0, n: 0 }
        map[key].x += dx; map[key].y += dy; map[key].n++
      }
    }
    var out = []
    for (var k in map) { var m = map[k]; out.push({ x: m.x / m.n, y: m.y / m.n, mag: Math.hypot(m.x / m.n, m.y / m.n), support: m.n }) }
    return out
  }

  // Lagrange-Gauss 2-D basis reduction: return the two SHORTEST independent vectors of the lattice
  // generated by (b0,b1). Position-invariant. CAPPED at GAUSS_CAP iterations (near-collinear inputs
  // can spin) — the standard round(dot/dot)==0 termination has no cap in the textbook algorithm.
  function gaussReduce (b0, b1) {
    b0 = { x: b0.x, y: b0.y }; b1 = { x: b1.x, y: b1.y }
    for (var it = 0; it < TEXT_TILING.GAUSS_CAP; it++) {
      if (vmag(b1) < vmag(b0)) { var t = b0; b0 = b1; b1 = t }
      var d0 = vdot(b0, b0); if (d0 === 0) break
      var m = Math.round(vdot(b0, b1) / d0)
      if (m === 0) break
      b1 = { x: b1.x - m * b0.x, y: b1.y - m * b0.y }
    }
    return [b0, b1]
  }

  // Deterministic subharmonic rejection (up front, not post-hoc). A non-overlapping tile period must
  // be >= the seed footprint projected onto the vector's direction. If a reduced vector is shorter, the
  // peak cloud held half-period matches (glyph sub-parts) — promote to the smallest integer multiple
  // that clears the footprint.
  function rejectSubharmonic (v, fw, fh) {
    var mag = vmag(v); if (mag === 0) return v
    var ux = v.x / mag, uy = v.y / mag
    var extent = Math.abs(ux) * fw + Math.abs(uy) * fh
    if (mag >= extent) return v
    var k = Math.ceil(extent / mag)
    return { x: v.x * k, y: v.y * k }
  }

  // Fraction of peaks lying within `tol` of an integer lattice node. A discriminative tile explains
  // ~all its (inlier) peaks; a sub-glyph fragment leaves most unexplained — the gate that rejects
  // fragment-seed over-stamps (e.g. boxing a single letter).
  function explainedFraction (peaks, v0, v1, origin, tol) {
    if (!peaks.length) return 0
    var det = v1 ? (v0.x * v1.y - v0.y * v1.x) : 0, ok = 0
    for (var p = 0; p < peaks.length; p++) {
      var rx = peaks[p].x - origin.x, ry = peaks[p].y - origin.y, nx, ny
      if (v1 && Math.abs(det) > 1e-9) {
        var i = Math.round((rx * v1.y - ry * v1.x) / det), j = Math.round((-rx * v0.y + ry * v0.x) / det)
        nx = origin.x + i * v0.x + j * v1.x; ny = origin.y + i * v0.y + j * v1.y
      } else {
        var t = Math.round((rx * v0.x + ry * v0.y) / (v0.x * v0.x + v0.y * v0.y))
        nx = origin.x + t * v0.x; ny = origin.y + t * v0.y
      }
      if (Math.hypot(peaks[p].x - nx, peaks[p].y - ny) <= tol) ok++
    }
    return ok / peaks.length
  }

  // Max residual of each peak to its nearest INTEGER lattice node — the fit-quality gate that drives
  // v1 selection (min drift wins) and 2-D vs 1-D fallback. Catches BOTH half-period locks and general
  // noise-driven bad fits (LEARNINGS CORE-22).
  function maxIntDrift (peaks, v0, v1, origin) {
    var det = v1 ? (v0.x * v1.y - v0.y * v1.x) : 0
    var maxR = 0
    for (var p = 0; p < peaks.length; p++) {
      var rx = peaks[p].x - origin.x, ry = peaks[p].y - origin.y, nx, ny
      if (v1 && Math.abs(det) > 1e-9) {
        var i = Math.round((rx * v1.y - ry * v1.x) / det), j = Math.round((-rx * v0.y + ry * v0.x) / det)
        nx = origin.x + i * v0.x + j * v1.x; ny = origin.y + i * v0.y + j * v1.y
      } else {
        var t = Math.round((rx * v0.x + ry * v0.y) / (v0.x * v0.x + v0.y * v0.y))
        nx = origin.x + t * v0.x; ny = origin.y + t * v0.y
      }
      var r = Math.hypot(peaks[p].x - nx, peaks[p].y - ny)
      if (r > maxR) maxR = r
    }
    return maxR
  }

  // Full fit: peaks (working coords) + template footprint (working px) -> {tiling, basis, explainedFrac}.
  // basis is in FULL-image px (rescaled by `inv`), canonicalised, ready for propagateMask(). Selection
  // is DRIFT-DRIVEN (fit quality), not shortest-first: among supported non-collinear candidates for v1,
  // pick the one whose reduced lattice best explains the peak cloud. A 2-D basis is accepted only if its
  // integer drift clears the tolerance — otherwise fall back to the 1-D v0 lattice. This is the
  // principled subharmonic/noise rejection (e.g. a spurious half-pitch offset has high drift and is
  // rejected; the true pitch has low drift and is kept).
  function globalLatticeFit (peaks, fw, fh, inv) {
    var result = { tiling: false, basis: [], explainedFrac: 0 }
    if (peaks.length < TEXT_TILING.MIN_PEAKS) return result
    // Inlier filter: true repeats of the seed score high NCC; cross-matches score lower and inject
    // subharmonic/noise offsets. Fit the lattice on the strong peaks only; keep >= MIN_PEAKS by
    // relaxing the cut if needed.
    var fitPeaks = peaks
    var strong = peaks.filter(function (p) { return p.v >= TEXT_TILING.INLIER_CUT })
    if (strong.length >= TEXT_TILING.MIN_PEAKS) fitPeaks = strong
    var Nf = fitPeaks.length
    var minSup = Math.max(2, Math.round(TEXT_TILING.MIN_SUPPORT_FRAC * Nf))
    var offs = supportedOffsets(fitPeaks, TEXT_TILING.OFFSET_TOL).filter(function (o) { return o.support >= minSup && o.mag >= 2 })
    if (!offs.length) return result
    offs.sort(function (a, b) { return a.mag - b.mag })
    // origin for drift = the strongest peak (the seed matches itself at NCC~1); a real node anchors the
    // integer indexing cleanly.
    var origin = fitPeaks[0]
    for (var oi = 1; oi < fitPeaks.length; oi++) if (fitPeaks[oi].v > origin.v) origin = fitPeaks[oi]
    var b0 = offs[0]
    var sinMin = Math.sin(TEXT_TILING.V1_MIN_DEG * Math.PI / 180)
    var driftTol = Math.max(TEXT_TILING.DRIFT_ABS, TEXT_TILING.DRIFT_FRAC * b0.mag)
    // Best non-collinear v1 by MIN integer drift of the reduced basis.
    var best = null
    for (var i = 0; i < offs.length; i++) {
      if (Math.abs(vcross(b0, offs[i])) / (b0.mag * offs[i].mag) <= sinMin) continue // collinear
      var red = gaussReduce(b0, offs[i])
      var d = maxIntDrift(fitPeaks, red[0], red[1], origin)
      if (!best || d < best.d) best = { red: red, d: d }
    }
    var reduced
    if (best && best.d <= driftTol) reduced = best.red // accept 2-D
    else reduced = [{ x: b0.x, y: b0.y }] // 1-D fallback
    // Explained-fraction gate: a valid lattice must account for most INLIER peaks. A non-discriminative
    // sub-glyph seed (single letter) yields a dense cloud where a sparse lattice explains few peaks even
    // if a lucky subset looks locally clean under drift alone.
    var expTol = Math.max(6, 0.2 * Math.min(vmag(reduced[0]), reduced[1] ? vmag(reduced[1]) : Infinity))
    var explained = explainedFraction(fitPeaks, reduced[0], reduced[1] || null, origin, expTol)
    result.explainedFrac = explained
    if (explained < TEXT_TILING.EXPLAIN_MIN) return result // non-tiling / fragment seed
    // Subharmonic rejection per vector (footprint in WORKING px), then rescale working -> full-image
    // px and canonicalise (mirrors detectTiling's basis convention).
    reduced = reduced.map(function (v) { return rejectSubharmonic(v, fw, fh) })
    result.basis = reduced.map(function (v) { return canonicalBasis(Math.round(v.x * inv), Math.round(v.y * inv)) })
    result.tiling = true
    return result
  }

  /**
   * detectTextTiling — find a tiled LETTER-FORM watermark by template-matching the user's boxed
   * instance against the whole image (fast NCC), then reading the repeat pitch as a lattice basis.
   *
   * Pure (TEST-2): reads imageData.data + region only; allocates its own buffers; touches no DOM.
   *
   * @param {ImageData|{data,width,height}} imageData  RGBA frame.
   * @param {{x:number,y:number,width:number,height:number}} region  the user's boxed ONE instance, in
   *        FULL-image coords. Reuses clampRegion() — identical region contract to detectTiling().
   * @returns {{tiling:boolean, instances:number, tileBasis:Array<{x:number,y:number}>, confidence:number}}
   *        tileBasis is in FULL-image pixels (rescaled from the working downscale), ready for
   *        propagateMask(): 1 vector -> single-line text, 2 -> grid. confidence is the lattice score,
   *        in (0,1] iff tiling (>= MIN_SCORE by construction), 0 otherwise (mirrors detectTiling).
   */
  function detectTextTiling (imageData, region) {
    var W = imageData.width, H = imageData.height
    var bb = clampRegion(region, W, H) // {x0,y0,x1,y1} in full coords — same conversion as detectTiling
    if (bb.x1 - bb.x0 < TEXT_TILING.MIN_TEMPLATE || bb.y1 - bb.y0 < TEXT_TILING.MIN_TEMPLATE) {
      return { tiling: false, instances: 0, tileBasis: [], confidence: 0 }
    }

    // Working resolution: longest side <= WORK_MAX so the 2-D FFT stays cheap (ample for glyph matching).
    var scale = Math.min(1, TEXT_TILING.WORK_MAX / Math.max(W, H))
    var dw = Math.max(1, Math.round(W * scale)), dh = Math.max(1, Math.round(H * scale))
    var work = scale < 1 ? downscaleToLuma(imageData, dw, dh) : fullLuma(imageData)

    // Template bbox in working coords; re-guard against a sub-template crop after the shrink.
    var tbox = {
      x0: Math.max(0, Math.round(bb.x0 * scale)), y0: Math.max(0, Math.round(bb.y0 * scale)),
      x1: Math.min(dw, Math.round(bb.x1 * scale)), y1: Math.min(dh, Math.round(bb.y1 * scale))
    }
    if (tbox.x1 - tbox.x0 < TEXT_TILING.MIN_TEMPLATE || tbox.y1 - tbox.y0 < TEXT_TILING.MIN_TEMPLATE) {
      return { tiling: false, instances: 0, tileBasis: [], confidence: 0 }
    }

    var res = fastNCC(work, dw, dh, tbox)
    var peaks = extractTextPeaks(res, TEXT_TILING.NCC_CUTOFF)
    if (peaks.length < TEXT_TILING.MIN_PEAKS) return { tiling: false, instances: peaks.length, tileBasis: [], confidence: 0 }

    // #58: GLOBAL lattice fit over the whole peak cloud, replacing the old seed-local NN v1 heuristic —
    // position-invariant (the same basis regardless of which instance was boxed) and rejects fragment
    // seeds via the explained-fraction gate. Rescale working vectors to full-image px (/scale) before
    // canonicalising, so propagateMask stamps at the true pitch on >1024px frames.
    var inv = scale < 1 ? 1 / scale : 1
    var fit = globalLatticeFit(peaks, tbox.x1 - tbox.x0, tbox.y1 - tbox.y0, inv)
    if (!fit.tiling) return { tiling: false, instances: peaks.length, tileBasis: [], confidence: 0 }

    // confidence: the explained-fraction (>= EXPLAIN_MIN by construction whenever tiling:true), so this
    // stays in (0,1] iff tiling — same invariant as the old lat.score-based confidence.
    return { tiling: true, instances: peaks.length, tileBasis: fit.basis, confidence: Math.min(fit.explainedFrac, 1) }
  }

  // =============================================================================================
  // foldMaskToCell (#60, T29 follow-up) — phrase-level seed expansion.
  //
  // On a letter-form phrase watermark ("TAYLOR GALE" repeated), detectTextTiling's fitted period
  // ALREADY equals the full phrase width, but detectWatermark only returns the ONE word the user
  // boxed — so propagateMask stamps a partial grid (box TAYLOR -> GALE survives, and vice-versa).
  // The fix is SEED EXPANSION, not re-fitting: translate a content mask (the caller supplies ONE
  // lattice cell's worth of real content — see latticeCellOrigin below; a whole-image mask was tried
  // first and rejected, see the caller note in runTile()) to the canonical fundamental cell via the
  // same floor-based modulo used for a full fold. propagateMask then stamps that unit across the grid
  // -> one box, one fill, identical result whichever word was boxed. Mechanism validated (mask-
  // coverage metrics only) in scripts/spike-phrase-tiling-60.js; fill-quality bug + fix found live in
  // the #60 build QA session (see runTile()'s #60 comment for the two failure modes and the fix).
  //
  // TWO CORRECTNESS TRAPS (do NOT "simplify" either — both silently corrupt the fold):
  //   1. FLOOR, not round (CORE-26). The in-cell residual comes from FLOORing each pixel's lattice
  //      coefficients, giving a true modulo into [0, cell) with a NON-NEGATIVE residual. Math.round
  //      snaps to the NEAREST node -> residuals in [-half,+half]; the negative half maps to fx<0 and
  //      is clipped by the bounds check, silently discarding ~half the content (a whole word).
  //   2. Anchor is lattice-CANONICAL, not the boxed seed's position (CORE-27). A fixed anchor (default
  //      (0,0)) folds the SAME content into the SAME absolute cell regardless of which instance was
  //      boxed -> position-invariant by construction. Anchoring at the seed defeats that.
  //
  // Pure: reads `mask`, allocates its own output, mutates nothing — Node-testable (TEST-2).
  //
  // @param {Uint8Array} mask   width*height content mask (e.g. detectWatermark(one-lattice-cell).mask —
  //        see latticeCellOrigin; a whole-image mask also works but risks cross-instance contamination).
  // @param {number} width
  // @param {number} height
  // @param {Array<{x:number,y:number}>} basis  1 or 2 lattice vectors (detectTextTiling().tileBasis).
  //        2 vectors -> fold into a 2-D parallelogram cell; 1 -> collapse onto a single period.
  // @param {{x:number,y:number}} [anchor]  fundamental-cell origin. Default {x:0,y:0} (canonical).
  // @returns {Uint8Array} fresh full-frame mask with the folded unit placed at the anchor cell.
  function foldMaskToCell (mask, width, height, basis, anchor) {
    var out = new Uint8Array(mask.length)
    var O = anchor || { x: 0, y: 0 }
    var v0 = basis && basis[0]
    if (!v0) return out // no lattice -> nothing to fold (caller guards; defensive)
    var v1 = basis[1] || null
    var det = v1 ? (v0.x * v1.y - v0.y * v1.x) : 0
    var v0sq = v0.x * v0.x + v0.y * v0.y
    for (var p = 0; p < mask.length; p++) {
      if (!mask[p]) continue
      var px = p % width, py = (p / width) | 0
      var rx = px - O.x, ry = py - O.y, fx, fy
      if (v1 && Math.abs(det) > 1e-9) {
        // Integer lattice indices via the 2x2 inverse of [v0 v1]; FLOOR -> true modulo (trap #1).
        var i = Math.floor((rx * v1.y - ry * v1.x) / det)
        var j = Math.floor((-rx * v0.y + ry * v0.x) / det)
        fx = px - i * v0.x - j * v1.x
        fy = py - i * v0.y - j * v1.y
      } else if (v0sq > 0) {
        var t = Math.floor((rx * v0.x + ry * v0.y) / v0sq)
        fx = px - t * v0.x
        fy = py - t * v0.y
      } else {
        continue // degenerate basis
      }
      fx = Math.round(fx); fy = Math.round(fy) // integer pixel index (residual is already in-cell)
      if (fx < 0 || fx >= width || fy < 0 || fy >= height) continue
      out[fy * width + fx] = 1
    }
    return out
  }

  // latticeCellOrigin (#60 build QA fix) — which lattice node's cell contains point (x,y)?
  //
  // WHY THIS EXISTS: the spike's whole-image fold (foldMaskToCell fed by a whole-frame
  // detectWatermark) turned out to corrupt the seed on real photos — two failure modes only visible
  // once the actual fill pipeline ran (the spike validated mask COVERAGE metrics, never fill
  // quality): (1) unrelated photographic edges (e.g. a mountain silhouette) get picked up by
  // whole-image Sobel and folded into the cell as noise; (2) the real watermark's own per-row content
  // has a few px of mutual jitter, so folding 3+ rows together SMEARS the shape instead of producing
  // one crisp unit. Both corrupt fillMaskRegion's BFS reconstruction into pale/white blob artifacts.
  //
  // THE FIX: instead of detecting across the whole frame, detect ONCE within the seed's OWN lattice
  // cell (a single real instance — no cross-row/cross-instance mixing, no distant photo content), then
  // fold/translate that ONE clean detection to the canonical anchor for stamping. This function finds
  // that cell's origin (same floor-based lattice-index math as foldMaskToCell, but for a single point
  // instead of a whole mask) so the caller can build the one-cell detection window.
  //
  // @param {number} x
  // @param {number} y
  // @param {Array<{x:number,y:number}>} basis  1 or 2 lattice vectors.
  // @param {{x:number,y:number}} [anchor]  Default {x:0,y:0} (canonical).
  // @returns {{x:number,y:number}} the lattice node (image px) whose cell contains (x,y).
  function latticeCellOrigin (x, y, basis, anchor) {
    var O = anchor || { x: 0, y: 0 }
    var v0 = basis && basis[0]
    if (!v0) return { x: 0, y: 0 }
    var v1 = basis[1] || null
    var rx = x - O.x, ry = y - O.y
    if (v1) {
      var det = v0.x * v1.y - v0.y * v1.x
      if (Math.abs(det) > 1e-9) {
        var i = Math.floor((rx * v1.y - ry * v1.x) / det)
        var j = Math.floor((-rx * v0.y + ry * v0.x) / det)
        return { x: i * v0.x + j * v1.x, y: i * v0.y + j * v1.y }
      }
    }
    var v0sq = v0.x * v0.x + v0.y * v0.y
    if (v0sq > 0) {
      var t = Math.floor((rx * v0.x + ry * v0.y) / v0sq)
      return { x: t * v0.x, y: t * v0.y }
    }
    return { x: 0, y: 0 } // degenerate basis
  }

  // =============================================================================================
  // propagateMask (#46, T29 Phase 3) — stamp one confirmed watermark instance across the lattice.
  //
  // DESIGN PRINCIPLE (preserve): recolour's differentiator is FIND-AND-MASK EVERY INSTANCE *before*
  // fill — the opposite of AI semantic-inpainting tools (e.g. DrWatermark) that reconstruct behind a
  // single mask and hope the guess is right. Masking all instances first (including ones invisible
  // against a matching background — white text over white sky) is deterministic and honest. Keep this
  // intent visible: the machine does not need to SEE the hidden instances, only to know where the
  // tiling says they must be.
  // =============================================================================================
  var PROPAGATE = {
    MAX_INSTANCES: 4096, // hard cap — a near-zero basis must not spin millions of stamps (DoS-shaped)
    MIN_BASIS_MAG: 2,    // basis vectors shorter than this are degenerate (treated as "no tiling")
    // frameCanonical (#57): count a node if its anchor lies in the frame EXPANDED by this fraction of a
    // half lattice cell per axis (0.5 == Voronoi cell overlaps frame). Makes the instance COUNT a
    // function of (basis, frame) only — invariant to which instance the user boxed (CORE-23). Validated
    // at 0.5 in scripts/spike-seed-invariance-57.js (18/18/18, ==trueCeil, no recall loss). Opt-in only.
    CANON_FRAC: 0.5
  }

  /**
   * Stamp `seedMask` at every lattice node spanned by `basis`, OR-ing into a fresh mask.
   *
   * Pure: reads `seedMask`, allocates its own output, mutates nothing — Node-testable (TEST-2).
   *
   * @param {Uint8Array} seedMask  width*height; non-zero marks the ONE confirmed instance. (The GUI
   *        slice will derive this from a manual region via detectWatermark(base, profile, region).mask.)
   * @param {number} width
   * @param {number} height
   * @param {Array<{x:number,y:number}>} basis  1 or 2 image-pixel lattice vectors, e.g.
   *        detectTiling().tileBasis. 1 vector -> stamp along a line; 2 -> stamp across the 2-D grid.
   * @param {object} [opts]  maxInstances: override the PROPAGATE.MAX_INSTANCES cap.
   *        frameCanonical (#57, default false): gate each node on its anchor lying in the frame expanded
   *        by half a lattice cell (basis-derived) instead of on the seed BBOX overlapping the frame. This
   *        makes `instances`/`rows`/`cols` a function of (basis, frame) only — position-invariant to which
   *        instance was boxed (CORE-23). Stamping is unchanged (real seed pixels at each counted node).
   * @returns {{mask:Uint8Array, instances:number, subharmonicWarning:boolean, rows:number, cols:number}}
   *   mask: the seed OR-stamped at every lattice node whose translated bbox overlaps the image,
   *         clamped to bounds.
   *   instances: TOTAL stamped copies INCLUDING the seed (node (0,0)). A seed with pixels but no valid
   *         basis returns 1, never 0 — the GUI "Found N regions" pill reads this directly, so a 1 means
   *         "just the seed". An EMPTY seed (no set pixels) returns 0.
   *   rows, cols: count of DISTINCT lattice lines that produced an in-bounds stamp — cols along v0,
   *         rows along v1. For a 1-D basis (no v1) rows collapses to 1 and cols === instances. Empty
   *         seed -> {rows:0, cols:0}; seed with no valid basis -> {rows:1, cols:1}. The GUI confirm card
   *         renders these as "Found N instances · R rows × C columns" (#47, T29 Phase 3 DoD).
   *   subharmonicWarning: true when a basis vector is shorter than the seed's bbox footprint projected
   *         onto that vector's direction. That is the FFT half-period lock (detectTiling can lock onto
   *         half the true period when the watermark has internal symmetry) — stamps would overlap
   *         heavily, which is physically impossible for a non-overlapping tiling. Non-blocking: the mask
   *         is still returned; the GUI slice surfaces it (e.g. "spacing looks halved — double it?").
   *         A richer per-instance content match-score is a Phase 4 follow-up.
   */
  function propagateMask (seedMask, width, height, basis, opts) {
    opts = opts || {}
    var maxInstances = opts.maxInstances != null ? opts.maxInstances : PROPAGATE.MAX_INSTANCES
    var frameCanonical = !!opts.frameCanonical // #57 count invariance — opt-in, see PROPAGATE.CANON_FRAC
    var out = new Uint8Array(seedMask.length)

    // Collect the seed's set-pixel coords + bbox once.
    var cx = [], cy = [], minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
    for (var p = 0; p < seedMask.length; p++) {
      if (!seedMask[p]) continue
      var x = p % width, y = (p / width) | 0
      cx.push(x); cy.push(y)
      if (x < minx) minx = x
      if (x > maxx) maxx = x
      if (y < miny) miny = y
      if (y > maxy) maxy = y
    }
    if (!cx.length) return { mask: out, instances: 0, subharmonicWarning: false, rows: 0, cols: 0 } // empty seed

    // Keep only non-degenerate basis vectors.
    var vecs = []
    if (basis) {
      for (var bi = 0; bi < basis.length; bi++) {
        var mag = Math.hypot(basis[bi].x, basis[bi].y)
        if (mag >= PROPAGATE.MIN_BASIS_MAG) vecs.push({ x: basis[bi].x, y: basis[bi].y, mag: mag })
      }
    }
    // No usable basis -> nothing to propagate; return just the seed (instances:1).
    if (!vecs.length) {
      for (var s0 = 0; s0 < cx.length; s0++) out[cy[s0] * width + cx[s0]] = 1
      return { mask: out, instances: 1, subharmonicWarning: false, rows: 1, cols: 1 }
    }

    // Sub-harmonic guard: project the seed bbox onto each basis direction; if the vector is shorter
    // than that footprint, adjacent stamps overlap heavily — the half-period lock signature.
    var bw = maxx - minx + 1, bh = maxy - miny + 1
    var subharmonicWarning = false
    for (var vi = 0; vi < vecs.length; vi++) {
      var ux = vecs[vi].x / vecs[vi].mag, uy = vecs[vi].y / vecs[vi].mag
      var extent = Math.abs(ux) * bw + Math.abs(uy) * bh
      if (vecs[vi].mag < extent) subharmonicWarning = true
    }

    // Sweep the lattice. (0,0) is the seed itself and is always stamped (its bbox is in-image). Node
    // ranges are bounded by image diagonal / basis magnitude; the MAX_INSTANCES cap is the hard stop.
    var v0 = vecs[0], v1 = vecs[1] || null
    var diag = width + height
    // frameCanonical needs a touch more reach: the expanded frame can admit one extra node past the
    // image edge, so widen the sweep bound by 1 (default path keeps its exact +1 -> counts unchanged).
    var iMax = Math.ceil(diag / v0.mag) + (frameCanonical ? 2 : 1)
    var jMax = v1 ? Math.ceil(diag / v1.mag) + (frameCanonical ? 2 : 1) : 0
    // Half a lattice cell per axis (frameCanonical gate). Zero on the default path (unused there).
    // TODO: make frameCanonical the default after #62 validates the seed-side (detectWatermark) path;
    // then this branch becomes the single node-gate and the bbox-overlap path can be retired.
    var hx = frameCanonical ? PROPAGATE.CANON_FRAC * 0.5 * (Math.abs(v0.x) + (v1 ? Math.abs(v1.x) : 0)) : 0
    var hy = frameCanonical ? PROPAGATE.CANON_FRAC * 0.5 * (Math.abs(v0.y) + (v1 ? Math.abs(v1.y) : 0)) : 0
    var instances = 0
    // Count DISTINCT lattice lines that produced an in-bounds stamp: cols = distinct i (along v0),
    // rows = distinct j (along v1). Cheap fixed-size seen-flags keyed by (index + max) — for a 1-D
    // basis jMax=0 so rows collapses to 1. Surfaced in the GUI confirm card (#47).
    var iSeen = new Uint8Array(2 * iMax + 1)
    var jSeen = new Uint8Array(2 * jMax + 1)
    var cols = 0, rows = 0
    for (var i = -iMax; i <= iMax; i++) {
      for (var j = -jMax; j <= jMax; j++) {
        var ox = Math.round(i * v0.x + (v1 ? j * v1.x : 0))
        var oy = Math.round(i * v0.y + (v1 ? j * v1.y : 0))
        if (frameCanonical) {
          // #57: gate on the node ANCHOR (seed bbox origin + offset) lying in the frame expanded by
          // half a cell — basis-derived, so the count is invariant to the seed footprint's size/phase.
          if (minx + ox < -hx || minx + ox >= width + hx || miny + oy < -hy || miny + oy >= height + hy) continue
        } else {
          // Default: stamp nodes whose translated seed BBOX overlaps the image (footprint-dependent).
          if (maxx + ox < 0 || minx + ox >= width || maxy + oy < 0 || miny + oy >= height) continue
        }
        instances++
        if (!iSeen[i + iMax]) { iSeen[i + iMax] = 1; cols++ }
        if (!jSeen[j + jMax]) { jSeen[j + jMax] = 1; rows++ }
        for (var s = 0; s < cx.length; s++) {
          var nx = cx[s] + ox, ny = cy[s] + oy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          out[ny * width + nx] = 1
        }
        if (instances >= maxInstances) { i = iMax + 1; break } // hard cap — abandon the rest of the sweep
      }
    }
    return { mask: out, instances: instances, subharmonicWarning: subharmonicWarning, rows: rows, cols: cols }
  }

  return {
    rgbToLab: rgbToLab,
    deltaE76: deltaE76,
    replaceColour: replaceColour,
    smartFill: smartFill,
    fillMaskRegion: fillMaskRegion,
    detectWatermark: detectWatermark,
    detectTiling: detectTiling,
    detectTextTiling: detectTextTiling,
    foldMaskToCell: foldMaskToCell,
    latticeCellOrigin: latticeCellOrigin,
    propagateMask: propagateMask
  }
})
