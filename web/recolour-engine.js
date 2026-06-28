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
    var nx, ny, nx0, nx1, ny0, ny1, found // dilation neighbour-scan locals (T30)

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

    // 1b. Mask dilation (T30). Anti-aliased letter edges blend into the background and fall
    //     just outside the exact-colour match, so the cardinal fill leaves them as a ghost halo.
    //     Expanding the mask by `dilate` px (default 0 = legacy behaviour) pulls those fringe
    //     pixels into the fill set: they become fill TARGETS and are excluded as background
    //     SOURCES, so they get reconstructed instead of surviving as a halo. `matched` is left
    //     reporting the ORIGINAL exact-match count — dilated pixels do not inflate it.
    //     CRITICAL: read from `mask`, write to a separate `fillMask`, so a freshly-dilated pixel
    //     cannot seed further growth in the same pass (that would silently bleed past `dilate` px).
    var dilate = (options && options.dilate) | 0
    var fillMask = mask
    if (dilate > 0) {
      fillMask = new Uint8Array(n)
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
    }

    // 2. #31 guard. Count the fill set and bail if it covers almost the whole region: with that
    //    little background left there is nothing meaningful to sample, the result is garbage, and
    //    the O(area) work can stall the main thread long enough to corrupt a GPU frame (the stripe /
    //    glitch artifacts in #31). Engine default maxFillRatio = 1 (effectively off) keeps the unit
    //    tests deterministic; the GUI opts in with 0.8. `skipped` lets the caller warn + not paint.
    var regionArea = (b.x1 - b.x0) * (b.y1 - b.y0)
    var fillCount = 0
    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) { if (fillMask[y * width + x]) fillCount++ }
    }
    var maxFillRatio = (options && typeof options.maxFillRatio === 'number') ? options.maxFillRatio : 1
    if (regionArea > 0 && fillCount / regionArea > maxFillRatio) {
      return { imageData: imageData, matched: matched, unfilled: fillCount, skipped: true }
    }

    // 3. BFS / Fast-Marching geodesic fill. Process masked pixels in non-decreasing geodesic
    //    (8-connected) distance from the mask boundary, estimating each pixel's colour as the
    //    inverse-distance-weighted mean of its already-KNOWN neighbours. Geodesic distance follows
    //    connected paths, so — unlike the old cardinal straight-line scan — it never crosses a
    //    background gap (concave masks) and always reaches corner/edge pixels (#32).
    //
    //    A pixel is a colour SOURCE (known=1) if it is original background: in-region and NOT in
    //    fillMask. The dilated fringe is in fillMask, so it is excluded as a source (CORE-8: never
    //    sample target-contaminated pixels).
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

    return { imageData: imageData, matched: matched, unfilled: unfilled }
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
  var DETECT_DEFAULTS = {
    edgeThreshold: 150,    // max-channel Sobel |gx|+|gy| (range ~0-2040). CALIBRATE on fixtures.
    minArea: 10,           // px — reject sub-noise specks
    maxAreaRatio: 0.5,     // reject a component covering more than this fraction of the region
    maxFillRatio: 0.65,    // filled-area / bbox-area above this = solid block -> reject
    minPerimeterRatio: 0.3, // perimeter / area below this = chunky/solid -> reject
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

  function detectWatermark (imageData, options, region) {
    var data = imageData.data
    var width = imageData.width
    var height = imageData.height
    var n = width * height
    var b = clampRegion(region, width, height)
    var opt = options || {}
    var edgeThreshold = opt.edgeThreshold != null ? opt.edgeThreshold : DETECT_DEFAULTS.edgeThreshold
    var minArea = opt.minArea != null ? opt.minArea : DETECT_DEFAULTS.minArea
    var maxAreaRatio = opt.maxAreaRatio != null ? opt.maxAreaRatio : DETECT_DEFAULTS.maxAreaRatio
    var maxFillRatio = opt.maxFillRatio != null ? opt.maxFillRatio : DETECT_DEFAULTS.maxFillRatio
    var minPerimeterRatio = opt.minPerimeterRatio != null ? opt.minPerimeterRatio : DETECT_DEFAULTS.minPerimeterRatio
    var lut = buildLut(!!opt.preContrast)

    var regionArea = (b.x1 - b.x0) * (b.y1 - b.y0)
    var mask = new Uint8Array(n)
    if (regionArea <= 0) return { mask: mask, components: [], confidence: 0 }

    var x, y, p, dx, dy, nx, ny, ch

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
          var tl = lut[data[oTL + ch]], t = lut[data[oT + ch]], tr = lut[data[oTR + ch]]
          var l = lut[data[oL + ch]], r = lut[data[oR + ch]]
          var bl = lut[data[oBL + ch]], bb = lut[data[oB + ch]], br = lut[data[oBR + ch]]
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
      var filledArea = fillHoles(c.pixels, width, c.x0, c.y0, bw, bh)
      var fillRatio = filledArea / bboxArea
      var perimRatio = c.area > 0 ? c.perimeter / c.area : 0
      var isText = c.area >= minArea &&
        (c.area / regionArea) <= maxAreaRatio &&
        fillRatio <= maxFillRatio &&
        perimRatio >= minPerimeterRatio
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

  return {
    rgbToLab: rgbToLab,
    deltaE76: deltaE76,
    replaceColour: replaceColour,
    smartFill: smartFill,
    detectWatermark: detectWatermark
  }
})
