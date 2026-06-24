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
   * @returns {{imageData: ImageData, matched: number}} the same buffer + match count.
   */
  function replaceColour (imageData, targetRgb, replaceRgb, tolerance) {
    const data = imageData.data
    const targetLab = rgbToLab(targetRgb) // hoisted: compute target LAB once, not per-pixel
    const hasAlpha = replaceRgb.length === 4 && replaceRgb[3] !== undefined
    let matched = 0

    for (let i = 0; i < data.length; i += 4) {
      const lab = rgbToLab([data[i], data[i + 1], data[i + 2]])
      if (deltaE76(lab, targetLab) <= tolerance) {
        data[i] = replaceRgb[0]
        data[i + 1] = replaceRgb[1]
        data[i + 2] = replaceRgb[2]
        if (hasAlpha) data[i + 3] = replaceRgb[3]
        matched++
      }
    }

    return { imageData: imageData, matched: matched }
  }

  return { rgbToLab: rgbToLab, deltaE76: deltaE76, replaceColour: replaceColour }
})
