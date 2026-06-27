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
   * Smart fill — cardinal distance-weighted inpainting (T16, issue #16).
   *
   * For each pixel matching the target colour, scan outward in 4 cardinal directions (L/R/U/D)
   * to the nearest ORIGINAL background pixel, then blend the 4 boundary colours weighted by
   * inverse distance (1/d). Because every target pixel reaches the original background directly
   * — with no intermediate filled pixels in the chain — there are no competing propagation
   * fronts and no chevron seam. Works in a single pass after an O(WH) pre-computation step.
   *
   * Why not onion-peel? Onion-peel fills from the outside in, so interior pixels inherit values
   * from previously-filled pixels (not the original background). On a gradient, the left-fill
   * front and the right-fill front propagate inward and collide at a visible seam regardless of
   * whether you use mode or mean aggregation. Cardinal interpolation bypasses that entirely.
   *
   * CONCAVE MASK CAVEAT: cardinal scans assume the nearest boundary in each direction is a
   * meaningful source. On concave masks (e.g. a watermark with a hole), a scan may exit the
   * target region, cross a gap of background, and hit the far boundary — pulling a distant
   * colour. For MVP rectangular/text watermarks this is rarely an issue. BFS distance-weighted
   * fill (Option 4) handles concave shapes better and is the documented next rung.
   *
   * FRINGE/HALO CAVEAT: if `tolerance` is too low the mask leaves a 1px semi-target fringe
   * unmasked; smart fill doesn't touch it → a faint halo. Fix: raise tolerance.
   *
   * @param {ImageData|{data,width,height}} imageData  RGBA buffer. Mutated IN PLACE.
   * @param {number[]} targetRgb   colour to remove, [r,g,b] (0-255).
   * @param {number} tolerance     Delta-E threshold (0-100). <= matches (same as replaceColour).
   * @param {object} [options]     Accepted for API compatibility; unused by this algorithm.
   * @param {object} [region]      Optional {x,y,width,height} in image pixel coords. When
   *        supplied, only pixels inside the rectangle are masked + filled (T17). The region
   *        edge then acts as a natural boundary: a matched pixel with no in-region non-target
   *        neighbour in a direction simply has no source there and blends from the others.
   *        Omitted → whole image. Clamped to image bounds.
   * @returns {{imageData: ImageData, matched: number, unfilled: number}}
   *        unfilled > 0 only when a target pixel has no non-target pixel in any direction
   *        (e.g. an all-target image with no background to sample).
   */
  function smartFill (imageData, targetRgb, tolerance, options, region) { // eslint-disable-line no-unused-vars
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

    // 2. Pre-compute the nearest original non-target pixel index and its distance in each of
    //    the 4 cardinal directions, scanning only within the region bounds. Two linear passes
    //    per row (L→R, R→L) + two per column (T→B, B→T). Sentinel: idx = -1 means no boundary
    //    in that direction (also what the region edge yields — exactly the desired behaviour).
    var lIdx = new Int32Array(n).fill(-1), lDst = new Uint16Array(n)
    var rIdx = new Int32Array(n).fill(-1), rDst = new Uint16Array(n)
    var uIdx = new Int32Array(n).fill(-1), uDst = new Uint16Array(n)
    var dIdx = new Int32Array(n).fill(-1), dDst = new Uint16Array(n)
    var lastP, lastX, lastY

    for (y = b.y0; y < b.y1; y++) {
      lastP = -1; lastX = 0
      for (x = b.x0; x < b.x1; x++) {
        p = y * width + x
        if (!mask[p]) { lastP = p; lastX = x } else if (lastP >= 0) { lIdx[p] = lastP; lDst[p] = x - lastX }
      }
      lastP = -1; lastX = 0
      for (x = b.x1 - 1; x >= b.x0; x--) {
        p = y * width + x
        if (!mask[p]) { lastP = p; lastX = x } else if (lastP >= 0) { rIdx[p] = lastP; rDst[p] = lastX - x }
      }
    }
    for (x = b.x0; x < b.x1; x++) {
      lastP = -1; lastY = 0
      for (y = b.y0; y < b.y1; y++) {
        p = y * width + x
        if (!mask[p]) { lastP = p; lastY = y } else if (lastP >= 0) { uIdx[p] = lastP; uDst[p] = y - lastY }
      }
      lastP = -1; lastY = 0
      for (y = b.y1 - 1; y >= b.y0; y--) {
        p = y * width + x
        if (!mask[p]) { lastP = p; lastY = y } else if (lastP >= 0) { dIdx[p] = lastP; dDst[p] = lastY - y }
      }
    }

    // 3. Single-pass inverse-distance-weighted fill. Each target pixel samples the 4 boundary
    //    colours from original non-target pixels directly — no propagation chain, no fronts.
    //    Safe to write in-place: lIdx/rIdx/uIdx/dIdx always point to mask=0 pixels which are
    //    never written, so read/write sets are disjoint (no deferred-write buffer needed).
    var timing = typeof window !== 'undefined'
    if (timing) console.time('smartFill')
    var unfilled = 0
    var rS, gS, bS, wS, w, idx

    for (y = b.y0; y < b.y1; y++) {
      for (x = b.x0; x < b.x1; x++) {
        p = y * width + x
        if (!mask[p]) continue
        rS = 0; gS = 0; bS = 0; wS = 0

        idx = lIdx[p]; if (idx >= 0) { w = 1 / lDst[p]; o = idx * 4; rS += data[o] * w; gS += data[o + 1] * w; bS += data[o + 2] * w; wS += w }
        idx = rIdx[p]; if (idx >= 0) { w = 1 / rDst[p]; o = idx * 4; rS += data[o] * w; gS += data[o + 1] * w; bS += data[o + 2] * w; wS += w }
        idx = uIdx[p]; if (idx >= 0) { w = 1 / uDst[p]; o = idx * 4; rS += data[o] * w; gS += data[o + 1] * w; bS += data[o + 2] * w; wS += w }
        idx = dIdx[p]; if (idx >= 0) { w = 1 / dDst[p]; o = idx * 4; rS += data[o] * w; gS += data[o + 1] * w; bS += data[o + 2] * w; wS += w }

        if (wS === 0) { unfilled++; continue }
        o = p * 4
        data[o]     = Math.round(rS / wS)
        data[o + 1] = Math.round(gS / wS)
        data[o + 2] = Math.round(bS / wS)
        // alpha preserved (not written) — mirrors replaceColour's 3-element behaviour
      }
    }
    if (timing) console.timeEnd('smartFill')

    return { imageData: imageData, matched: matched, unfilled: unfilled }
  }

  return {
    rgbToLab: rgbToLab,
    deltaE76: deltaE76,
    replaceColour: replaceColour,
    smartFill: smartFill
  }
})
