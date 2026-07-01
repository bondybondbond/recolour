/* eslint-env mocha */

const assert = require('assert')
const colorConvert = require('color-convert')
const deltaE = require('delta-e')
const engine = require('../web/recolour-engine')

// Build a synthetic ImageData-like buffer: ImageData is just { data, width, height }
// where data is a flat RGBA Uint8ClampedArray. No real canvas needed in Node.
function makeImage (pixels) {
  const data = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach((p, i) => {
    data[i * 4] = p[0]
    data[i * 4 + 1] = p[1]
    data[i * 4 + 2] = p[2]
    data[i * 4 + 3] = p.length > 3 ? p[3] : 255
  })
  return { data: data, width: pixels.length, height: 1 }
}

// 2D variant for smartFill — a 1-row strip can't exercise the interior-fill cases that
// are the whole point of the feature. `rows` is an array of rows, each an array of
// [r,g,b] or [r,g,b,a] pixels. Returns { data, width, height }.
function makeGrid (rows) {
  const height = rows.length
  const width = rows[0].length
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = rows[y][x]
      const o = (y * width + x) * 4
      data[o] = p[0]
      data[o + 1] = p[1]
      data[o + 2] = p[2]
      data[o + 3] = p.length > 3 ? p[3] : 255
    }
  }
  return { data: data, width: width, height: height }
}

// Read a pixel's RGBA out of a {data,width} buffer.
function pixelAt (img, x, y) {
  const o = (y * img.width + x) * 4
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]]
}

describe('recolour engine', function () {
  describe('rgbToLab — parity with color-convert', function () {
    // Use color-convert's .raw path (the default API rounds to integers, which
    // would make this assertion weaker than it looks).
    const samples = [[0, 0, 0], [255, 255, 255], [192, 57, 43], [79, 152, 163], [10, 200, 30]]

    samples.forEach((rgb) => {
      it(`matches color-convert for [${rgb}]`, () => {
        const got = engine.rgbToLab(rgb)
        const expected = colorConvert.rgb.lab.raw(rgb)
        for (let i = 0; i < 3; i++) {
          assert.ok(Math.abs(got[i] - expected[i]) < 0.001, `channel ${i}: ${got[i]} vs ${expected[i]}`)
        }
      })
    })
  })

  describe('deltaE76 — parity with delta-e package', function () {
    it('matches delta-e getDeltaE76', () => {
      const lab1 = engine.rgbToLab([192, 57, 43])
      const lab2 = engine.rgbToLab([200, 60, 50])
      const got = engine.deltaE76(lab1, lab2)
      const expected = deltaE.getDeltaE76(
        { L: lab1[0], A: lab1[1], B: lab1[2] },
        { L: lab2[0], A: lab2[1], B: lab2[2] }
      )
      assert.ok(Math.abs(got - expected) < 0.001, `${got} vs ${expected}`)
    })

    it('is zero for identical colours', () => {
      const lab = engine.rgbToLab([123, 45, 67])
      assert.strictEqual(engine.deltaE76(lab, lab), 0)
    })
  })

  describe('replaceColour', function () {
    it('replaces matching pixels, leaves others untouched, and counts matches', () => {
      const red = [192, 57, 43]
      const blue = [40, 60, 200]
      const img = makeImage([red, blue, red, [41, 61, 201]]) // px0,2 exact red; px3 near-blue
      const { imageData, matched } = engine.replaceColour(img, red, [255, 255, 255], 2.3)

      assert.strictEqual(matched, 2)
      // matched red pixels -> white
      assert.deepStrictEqual([imageData.data[0], imageData.data[1], imageData.data[2]], [255, 255, 255])
      assert.deepStrictEqual([imageData.data[8], imageData.data[9], imageData.data[10]], [255, 255, 255])
      // blue pixels untouched
      assert.deepStrictEqual([imageData.data[4], imageData.data[5], imageData.data[6]], blue)
      assert.deepStrictEqual([imageData.data[12], imageData.data[13], imageData.data[14]], [41, 61, 201])
    })

    it('mutates in place and returns the same buffer', () => {
      const img = makeImage([[10, 20, 30]])
      const result = engine.replaceColour(img, [10, 20, 30], [0, 0, 0], 1)
      assert.strictEqual(result.imageData, img)
    })

    it('respects the tolerance boundary', () => {
      const target = [100, 100, 100]
      const near = [108, 100, 100] // a few Delta-E away
      const dist = engine.deltaE76(engine.rgbToLab(target), engine.rgbToLab(near))

      // below the gap -> no match
      const low = engine.replaceColour(makeImage([near]), target, [0, 0, 0], dist - 0.5)
      assert.strictEqual(low.matched, 0)
      // at/above the gap -> match
      const high = engine.replaceColour(makeImage([near]), target, [0, 0, 0], dist + 0.5)
      assert.strictEqual(high.matched, 1)
    })

    it('preserves original alpha when replaceRgb has no alpha (3 elements)', () => {
      const img = makeImage([[200, 0, 0, 128]]) // 50%-ish alpha
      engine.replaceColour(img, [200, 0, 0], [0, 0, 255], 1)
      assert.deepStrictEqual([img.data[0], img.data[1], img.data[2]], [0, 0, 255])
      assert.strictEqual(img.data[3], 128) // alpha unchanged
    })

    it('overwrites alpha when replaceRgb supplies it (4 elements)', () => {
      const img = makeImage([[200, 0, 0, 128]])
      engine.replaceColour(img, [200, 0, 0], [0, 0, 255, 64], 1)
      assert.deepStrictEqual([img.data[0], img.data[1], img.data[2], img.data[3]], [0, 0, 255, 64])
    })
  })

  describe('smartFill', function () {
    const T = [200, 0, 0] // target (red) to remove
    const A = [0, 100, 0] // dominant neighbour (green)
    const B = [0, 0, 100] // secondary neighbour (blue)

    it('fills a lone target pixel with its surrounding colour', () => {
      const img = makeGrid([
        [A, A, A],
        [A, T, A],
        [A, A, A]
      ])
      const { matched, unfilled } = engine.smartFill(img, T, 10)
      assert.strictEqual(matched, 1)
      assert.strictEqual(unfilled, 0)
      assert.deepStrictEqual(pixelAt(img, 1, 1).slice(0, 3), A)
    })

    it('fully fills a thick block including the hollow centre (no unfilled pixels)', () => {
      // 5x5: outer ring = A, inner 3x3 = target. The centre pixel is 2px from every boundary.
      // Cardinal interpolation reaches the original A boundary directly in all 4 directions.
      const img = makeGrid([
        [A, A, A, A, A],
        [A, T, T, T, A],
        [A, T, T, T, A],
        [A, T, T, T, A],
        [A, A, A, A, A]
      ])
      const { matched, unfilled } = engine.smartFill(img, T, 10)
      assert.strictEqual(matched, 9)
      assert.strictEqual(unfilled, 0)
      assert.deepStrictEqual(pixelAt(img, 2, 2).slice(0, 3), A) // dead-centre reconstructed
    })

    it('averages neighbours, producing a blend on a gradient (not a discrete winner)', () => {
      // A (green) to the left, B (blue) to the right, equal count — average should be
      // midpoint [0,50,50], not A or B. This is the key gradient-artifact fix: mode
      // would hard-pick one side, producing a visible seam; average blends smoothly.
      const img = makeGrid([
        [A, A, A],
        [A, T, B],
        [A, A, B]
      ])
      // 5 A neighbours + 2 B neighbours → mean = round((5*A + 2*B) / 7 per channel)
      // A=[0,100,0] B=[0,0,100]: r=0, g=round(500/7)=71, b=round(200/7)=29
      engine.smartFill(img, T, 10)
      const px = pixelAt(img, 1, 1).slice(0, 3)
      assert.ok(px[0] === 0, 'r should be 0')
      assert.ok(px[1] > 0 && px[1] < 100, `g should be a blend, got ${px[1]}`)
      assert.ok(px[2] > 0 && px[2] < 100, `b should be a blend, got ${px[2]}`)
    })

    it('preserves the original alpha of a filled pixel', () => {
      const img = makeGrid([
        [A, A, A],
        [A, [200, 0, 0, 128], A],
        [A, A, A]
      ])
      engine.smartFill(img, T, 10)
      assert.deepStrictEqual(pixelAt(img, 1, 1), [A[0], A[1], A[2], 128])
    })

    it('leaves pixels unfilled when there is no non-target pixel in any direction', () => {
      // All-target image: every cardinal scan hits only target pixels or the image edge,
      // so wS=0 and all pixels go to unfilled. No hang (single-pass, no iteration cap needed).
      const img = makeGrid([
        [T, T],
        [T, T]
      ])
      const { matched, unfilled } = engine.smartFill(img, T, 10)
      assert.strictEqual(matched, 4)
      assert.strictEqual(unfilled, 4)
    })

    it('mutates in place and returns the same buffer', () => {
      const img = makeGrid([[A, T, A]])
      const result = engine.smartFill(img, T, 10)
      assert.strictEqual(result.imageData, img)
    })
  })

  // Mask dilation (T30): options.dilate expands the match mask by N px before filling so
  // anti-aliased edge pixels (a near-target fringe just outside the colour match) are
  // reconstructed from the true background instead of surviving as a halo. Default 0 = legacy.
  describe('smartFill dilation (T30)', function () {
    const T = [200, 0, 0]   // target (red) — the only colour that matches at tol 10
    const B = [0, 0, 100]   // anti-aliased FRINGE ring (Chebyshev-1 from target); not matched
    const C = [100, 0, 100] // TRUE background just outside the fringe (Chebyshev-2)
    const A = [0, 100, 0]   // FAR background (Chebyshev >= 3)

    // 7x7 with the target at centre (3,3), wrapped by a 1px B fringe, then a C ring, then A.
    // d = Chebyshev distance from (3,3): 0->T, 1->B, 2->C, >=3->A.
    function layered () {
      return makeGrid([
        [A, A, A, A, A, A, A],
        [A, C, C, C, C, C, A],
        [A, C, B, B, B, C, A],
        [A, C, B, T, B, C, A],
        [A, C, B, B, B, C, A],
        [A, C, C, C, C, C, A],
        [A, A, A, A, A, A, A]
      ])
    }

    it('without dilation, the fringe survives: centre is filled from the immediate B ring (the halo)', () => {
      const img = layered()
      const { matched, unfilled } = engine.smartFill(img, T, 10) // dilate defaults to 0
      assert.strictEqual(matched, 1)
      assert.strictEqual(unfilled, 0)
      assert.deepStrictEqual(pixelAt(img, 3, 3).slice(0, 3), B) // halo: centre took the fringe colour
      assert.deepStrictEqual(pixelAt(img, 3, 2).slice(0, 3), B) // fringe ring left untouched
    })

    it('with dilate:1 the fringe is reconstructed and the centre samples past it (halo gone)', () => {
      const img = layered()
      const { matched, unfilled } = engine.smartFill(img, T, 10, { dilate: 1 })
      assert.strictEqual(matched, 1)   // matched counts ONLY the exact-colour match, not dilated px
      assert.strictEqual(unfilled, 0)
      assert.deepStrictEqual(pixelAt(img, 3, 3).slice(0, 3), C) // centre now samples the true bg, not B
      assert.deepStrictEqual(pixelAt(img, 3, 2).slice(0, 3), C) // a B fringe pixel was reconstructed (was B)
    })

    it('dilate:1 grows by EXACTLY 1px — the Chebyshev-2 ring is never touched (no 2px bleed)', () => {
      // If the dilation pass read & wrote the same buffer, freshly-dilated pixels would seed
      // further growth and the C ring would become fill targets (reconstructing to A != C).
      const img = layered()
      engine.smartFill(img, T, 10, { dilate: 1 })
      assert.deepStrictEqual(pixelAt(img, 3, 1).slice(0, 3), C) // C ring, edge: unchanged source
      assert.deepStrictEqual(pixelAt(img, 1, 1).slice(0, 3), C) // C ring, corner: unchanged source
      assert.deepStrictEqual(pixelAt(img, 3, 0).slice(0, 3), A) // far bg: unchanged
    })

    it('omitting options reproduces the legacy fill exactly (dilate defaults to 0)', () => {
      const a = layered(); engine.smartFill(a, T, 10)
      const b = layered(); engine.smartFill(b, T, 10, { dilate: 0 })
      assert.deepStrictEqual(Array.from(a.data), Array.from(b.data))
    })

    it('clamps dilation to the region — never marks or changes pixels outside it', () => {
      // Target at the top-left CORNER of the region; without clamping, dilation would expand
      // up/left into pixels outside the region. Those must stay untouched.
      const img = makeGrid([
        [A, A, A, A, A],
        [A, T, A, A, A],
        [A, A, A, A, A],
        [A, A, A, A, A],
        [A, A, A, A, A]
      ])
      const { matched, unfilled } = engine.smartFill(img, T, 10, { dilate: 1 }, { x: 1, y: 1, width: 3, height: 3 })
      assert.strictEqual(matched, 1)
      assert.strictEqual(unfilled, 0)
      assert.deepStrictEqual(pixelAt(img, 1, 1).slice(0, 3), A) // target reconstructed from in-region bg
      assert.deepStrictEqual(pixelAt(img, 0, 1).slice(0, 3), A) // just left of region: untouched
      assert.deepStrictEqual(pixelAt(img, 1, 0).slice(0, 3), A) // just above region: untouched
    })
  })

  // BFS / Fast-Marching geodesic fill (T42). The cardinal scan left corner/edge pixels of a
  // full-perimeter mask unfilled (#32) and could pull distant colours across gaps on concave
  // masks. Geodesic BFS follows connected paths, so it reaches every pixel with a path to
  // background. Also adds the #31 guard: options.maxFillRatio skips the fill when nearly the
  // whole region matches.
  describe('smartFill BFS / geodesic fill (T42)', function () {
    const A = [0, 100, 0] // background
    const T = [200, 0, 0] // target to remove

    it('fills corner pixels of a full-perimeter mask that the cardinal scan left unfilled (#32)', () => {
      // 5x5: the entire perimeter (ring) is target, the inner 3x3 is background. From a corner,
      // every cardinal ray runs along the all-target edge and finds no source -> cardinal left it
      // unfilled. The corner is 8-connected to an interior background pixel, so BFS fills it.
      const img = makeGrid([
        [T, T, T, T, T],
        [T, A, A, A, T],
        [T, A, A, A, T],
        [T, A, A, A, T],
        [T, T, T, T, T]
      ])
      const { matched, unfilled } = engine.smartFill(img, T, 10)
      assert.strictEqual(matched, 16)              // the 16 perimeter pixels
      assert.strictEqual(unfilled, 0)              // nothing left unfilled — the #32 fix
      assert.deepStrictEqual(pixelAt(img, 0, 0).slice(0, 3), A) // corner reconstructed from interior bg
      assert.deepStrictEqual(pixelAt(img, 4, 4).slice(0, 3), A) // opposite corner too
    })

    it('reaches a deep concave interior with no original neighbour (geodesic propagation)', () => {
      // A solid 3x3 target block walled by background only on the outside. The dead-centre pixel
      // has no original-background neighbour; it fills only because BFS lets earlier-filled pixels
      // act as sources in strict distance order.
      const img = makeGrid([
        [A, A, A, A, A],
        [A, T, T, T, A],
        [A, T, T, T, A],
        [A, T, T, T, A],
        [A, A, A, A, A]
      ])
      const { unfilled } = engine.smartFill(img, T, 10)
      assert.strictEqual(unfilled, 0)
      assert.deepStrictEqual(pixelAt(img, 2, 2).slice(0, 3), A)
    })

    describe('maxFillRatio guard (#31)', function () {
      // 5x5: only the 4 corners are background (4/25), so 21/25 = 0.84 of the region is fill.
      function mostlyTarget () {
        return makeGrid([
          [A, T, T, T, A],
          [T, T, T, T, T],
          [T, T, T, T, T],
          [T, T, T, T, T],
          [A, T, T, T, A]
        ])
      }

      it('skips the fill and returns skipped:true when fill ratio exceeds maxFillRatio', () => {
        const img = mostlyTarget()
        const res = engine.smartFill(img, T, 10, { maxFillRatio: 0.8 })
        assert.strictEqual(res.skipped, true)
        assert.strictEqual(res.matched, 21)
        assert.strictEqual(res.unfilled, 21)                       // every fill pixel reported unfilled
        assert.deepStrictEqual(pixelAt(img, 2, 2).slice(0, 3), T)  // buffer untouched
      })

      it('fills normally when maxFillRatio is omitted (engine default = off)', () => {
        const img = mostlyTarget()
        const res = engine.smartFill(img, T, 10)
        assert.notStrictEqual(res.skipped, true)
        assert.strictEqual(res.unfilled, 0)
        assert.deepStrictEqual(pixelAt(img, 2, 2).slice(0, 3), A)  // reconstructed from the corner bg
      })
    })
  })

  // Region selection (T17): the optional 5th arg constrains the scan to a rectangle in
  // image pixel coords. Omitting it must reproduce the whole-image behaviour exactly.
  describe('region (T17)', function () {
    const red = [200, 0, 0]
    const white = [255, 255, 255]

    describe('replaceColour', function () {
      it('only replaces matching pixels inside the region; identical colour outside is untouched', () => {
        // 4x1 strip, all red. Region covers cols 1..2 only.
        const img = makeImage([red, red, red, red])
        const { matched } = engine.replaceColour(img, red, white, 5, { x: 1, y: 0, width: 2, height: 1 })
        assert.strictEqual(matched, 2)
        assert.deepStrictEqual(pixelAt(img, 0, 0).slice(0, 3), red)   // outside-left: untouched
        assert.deepStrictEqual(pixelAt(img, 1, 0).slice(0, 3), white) // inside: replaced
        assert.deepStrictEqual(pixelAt(img, 2, 0).slice(0, 3), white) // inside: replaced
        assert.deepStrictEqual(pixelAt(img, 3, 0).slice(0, 3), red)   // outside-right: untouched
      })

      it('constrains a 2D region to its rows and columns', () => {
        // 3x3 all red; region = the single centre pixel (1,1).
        const img = makeGrid([
          [red, red, red],
          [red, red, red],
          [red, red, red]
        ])
        const { matched } = engine.replaceColour(img, red, white, 5, { x: 1, y: 1, width: 1, height: 1 })
        assert.strictEqual(matched, 1)
        assert.deepStrictEqual(pixelAt(img, 1, 1).slice(0, 3), white)
        // every other pixel still red
        assert.deepStrictEqual(pixelAt(img, 0, 0).slice(0, 3), red)
        assert.deepStrictEqual(pixelAt(img, 2, 2).slice(0, 3), red)
        assert.deepStrictEqual(pixelAt(img, 1, 0).slice(0, 3), red)
      })

      it('omitting the region reproduces whole-image replacement', () => {
        const img = makeImage([red, red, red, red])
        const { matched } = engine.replaceColour(img, red, white, 5)
        assert.strictEqual(matched, 4)
      })

      it('clamps an over-large region to image bounds (no out-of-range write)', () => {
        const img = makeImage([red, red])
        const { matched } = engine.replaceColour(img, red, white, 5, { x: -5, y: -5, width: 100, height: 100 })
        assert.strictEqual(matched, 2) // clamped to the whole 2x1 image, no throw
      })
    })

    describe('smartFill', function () {
      const A = [0, 100, 0]
      const T = [200, 0, 0]

      it('only fills target pixels inside the region; matching target outside is left intact', () => {
        // Two lone red pixels on a green field; region encloses only the left one.
        const img = makeGrid([
          [A, A, A, A, A],
          [A, T, A, T, A],
          [A, A, A, A, A]
        ])
        const { matched, unfilled } = engine.smartFill(img, T, 10, undefined, { x: 0, y: 0, width: 3, height: 3 })
        assert.strictEqual(matched, 1)   // only the in-region target counted
        assert.strictEqual(unfilled, 0)
        assert.deepStrictEqual(pixelAt(img, 1, 1).slice(0, 3), A) // inside: filled from neighbours
        assert.deepStrictEqual(pixelAt(img, 3, 1).slice(0, 3), T) // outside: still target red
      })

      it('omitting the region reproduces whole-image smart fill', () => {
        const img = makeGrid([
          [A, A, A],
          [A, T, A],
          [A, A, A]
        ])
        const { matched, unfilled } = engine.smartFill(img, T, 10)
        assert.strictEqual(matched, 1)
        assert.strictEqual(unfilled, 0)
        assert.deepStrictEqual(pixelAt(img, 1, 1).slice(0, 3), A)
      })
    })
  })

  describe('detectWatermark (T29 Phase 2)', function () {
    // Build a solid-colour {data,width,height} buffer, then stamp shapes into it. Far less
    // verbose than makeGrid for the 20-60px grids the detector needs to exercise.
    function solid (w, h, rgb) {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255
      }
      return { data: data, width: w, height: h }
    }
    function rect (img, x0, y0, x1, y1, rgb) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const o = (y * img.width + x) * 4
          img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]
        }
      }
    }
    // A thin "+" — the canonical text-like shape: low bbox fill-ratio, high perimeter:area.
    function plus (img, cx, cy, arm, rgb) {
      rect(img, cx - 1, cy - arm, cx + 1, cy + arm, rgb) // 3px-wide vertical bar
      rect(img, cx - arm, cy - 1, cx + arm, cy + 1, rgb) // 3px-tall horizontal bar
    }
    function maskCount (mask) {
      let c = 0
      for (let i = 0; i < mask.length; i++) if (mask[i]) c++
      return c
    }

    const WHITE = [255, 255, 255]
    const BLACK = [0, 0, 0]

    it('detects a thin text-like shape and produces a non-empty mask', () => {
      const img = solid(24, 24, WHITE)
      plus(img, 12, 12, 7, BLACK)
      const { mask, components, confidence } = engine.detectWatermark(img)
      assert.ok(components.length >= 1, `expected >=1 component, got ${components.length}`)
      assert.ok(maskCount(mask) > 0, 'mask should flag some pixels')
      assert.ok(confidence > 0 && confidence <= 1, `confidence out of range: ${confidence}`)
    })

    it('rejects a solid filled block (hole-fill => high fill-ratio => not text)', () => {
      const img = solid(24, 24, WHITE)
      rect(img, 6, 6, 17, 17, BLACK) // 12x12 solid square
      const { mask, components, confidence } = engine.detectWatermark(img)
      assert.strictEqual(components.length, 0, 'a solid block must not be classified as text')
      assert.strictEqual(maskCount(mask), 0)
      assert.strictEqual(confidence, 0)
    })

    it('returns nothing on a flat field (no edges)', () => {
      const img = solid(16, 16, WHITE)
      const { mask, components, confidence } = engine.detectWatermark(img)
      assert.strictEqual(components.length, 0)
      assert.strictEqual(maskCount(mask), 0)
      assert.strictEqual(confidence, 0)
    })

    it('honours the region: a shape outside the box is ignored, inside is found', () => {
      const img = solid(32, 24, WHITE)
      plus(img, 8, 12, 6, BLACK) // left half
      // Region over the empty RIGHT half -> nothing.
      const right = engine.detectWatermark(img, null, { x: 18, y: 0, width: 14, height: 24 })
      assert.strictEqual(right.components.length, 0, 'shape outside region must be ignored')
      // Region over the LEFT half (contains the plus) -> found.
      const left = engine.detectWatermark(img, null, { x: 0, y: 0, width: 16, height: 24 })
      assert.ok(left.components.length >= 1, 'shape inside region must be detected')
    })

    it('per-channel Sobel catches an iso-luminant colour-separated shape (luminance would miss)', () => {
      // bg and fg have near-equal luminance (~129/~131) but large per-channel deltas. A
      // luminance-only Sobel sees ~3 and finds no edges; max-channel Sobel sees ~255.
      const BG = [0, 180, 0]
      const FG = [255, 95, 130]
      const img = solid(24, 24, BG)
      plus(img, 12, 12, 7, FG)
      const { components } = engine.detectWatermark(img)
      assert.ok(components.length >= 1, 'colour-separated shape must be detected via per-channel Sobel')
    })

    it('the preContrast path runs and still detects', () => {
      const img = solid(24, 24, WHITE)
      plus(img, 12, 12, 7, BLACK)
      const { components } = engine.detectWatermark(img, { preContrast: true })
      assert.ok(components.length >= 1, 'preContrast:true must not break detection')
    })

    it('preContrast:true detects a near-grey watermark that preContrast:false misses', () => {
      // bg=[128,128,128] fg=[155,155,155]: raw Sobel at edge = 4*(155-128) = 108 < threshold 150
      // (no detection). After invert+contrast: lut[155]≈83, lut[128]≈126, Sobel = 4*43 = 172
      // >= 150 (detected). Guards the real-world finding that light/white watermarks on
      // mid-tone photo backgrounds are invisible to raw Sobel but caught after preContrast.
      const bg = [128, 128, 128]
      const fg = [155, 155, 155]
      const img = solid(24, 24, bg)
      plus(img, 12, 12, 7, fg)
      const withoutPC = engine.detectWatermark(img, { preContrast: false })
      const withPC = engine.detectWatermark(img, { preContrast: true })
      assert.strictEqual(withoutPC.components.length, 0, 'raw Sobel below threshold — no detection without preContrast')
      assert.ok(withPC.components.length >= 1, 'invert+contrast amplifies the near-grey edge above threshold')
    })

    it('confidence is higher for several similar blobs than for a single blob', () => {
      const single = solid(20, 20, WHITE)
      plus(single, 10, 10, 6, BLACK)
      const one = engine.detectWatermark(single)

      const many = solid(64, 16, WHITE)
      plus(many, 8, 8, 5, BLACK)
      plus(many, 24, 8, 5, BLACK)
      plus(many, 40, 8, 5, BLACK)
      plus(many, 56, 8, 5, BLACK)
      const four = engine.detectWatermark(many)

      assert.ok(four.components.length > one.components.length, 'should find more blobs')
      assert.ok(four.confidence > one.confidence, `expected ${four.confidence} > ${one.confidence}`)
      assert.ok(one.confidence >= 0 && four.confidence <= 1, 'confidence must stay in [0,1]')
    })

    // ---- #45 lever regression ---------------------------------------------------------------
    // Exercises the new blurRadius + minAspect levers MECHANICALLY on a high-contrast synthetic: blur
    // + high threshold + wide-aspect gate drop mid-frequency texture while keeping a wide light stroke.
    // NB: #45 found this does NOT generalise to FAINT tiled watermarks on real photos (edge detection
    // can't separate them — re-scoped to an FFT ticket); these tests guard the lever plumbing, not
    // real-watermark efficacy. The GUI ships a conservative profile, not this one.
    const DETECT_PROFILE = { blurRadius: 1, edgeThreshold: 300, preContrast: false, minAspect: 3 }

    // A DISTINCT, deterministic adversarial fixture — built separately from the harness synthetic in
    // scripts/calibrate-detect.js, so these tests can't pass merely by sharing its tuned shape.
    // Diagonal mid-frequency stripes + per-cell hash jitter approximate photo texture. The optional
    // watermark is a thick "comb" (continuous baseline + upward teeth): a thin stroke fragments under
    // blur, a solid bar reads as a block (fill-ratio), separate letters are too narrow for minAspect,
    // and an enclosed shape fills its holes — a comb is wide (aspect >> 3), thick enough to survive
    // blur, sparse with NO enclosed holes (low fill-ratio), and one connected component.
    function adversarial (withWatermark) {
      const w = 200, h = 140
      const data = new Uint8ClampedArray(w * h * 4)
      const hash = (x, y) => { let v = (x * 374761393 + y * 668265263) >>> 0; v = (v ^ (v >> 13)) >>> 0; return v % 48 }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4
          const stripe = ((x + y) % 6 < 3) ? 26 : -26 // diagonal mid-freq stripes
          const jitter = hash(x >> 1, y >> 1) - 24 // ~ +-24, constant within a 2px cell
          let base = 120 + stripe + jitter
          if (base < 0) base = 0; if (base > 255) base = 255
          data[o] = data[o + 1] = data[o + 2] = base
          data[o + 3] = 255
        }
      }
      const x0 = 20, x1 = 180, baseY = 74, thick = 3, toothH = 10, toothW = 3, toothGap = 12
      const wmBox = { x0: x0, y0: baseY - toothH, x1: x1, y1: baseY + thick }
      const stamp = (x, y) => { const o = (y * w + x) * 4; data[o] = data[o + 1] = data[o + 2] = 250 }
      if (withWatermark) {
        for (let x = x0; x <= x1; x++) for (let t = 0; t < thick; t++) stamp(x, baseY + t) // baseline
        for (let x = x0; x <= x1; x += toothGap) { // upward teeth
          for (let ty = baseY - toothH; ty < baseY; ty++) for (let tw = 0; tw < toothW; tw++) if (x + tw <= x1) stamp(x + tw, ty)
        }
      }
      return { img: { data: data, width: w, height: h }, wmBox: wmBox }
    }

    it('drops photographic texture: adversarial field (no watermark) yields <= 3 candidates', () => {
      const { img } = adversarial(false)
      const { components } = engine.detectWatermark(img, DETECT_PROFILE)
      assert.ok(components.length <= 3, `texture must be rejected, got ${components.length} candidates`)
    })

    it('keeps the watermark: stamped wide light stroke survives the profile and clears minAspect', () => {
      const { img, wmBox } = adversarial(true)
      const { components } = engine.detectWatermark(img, DETECT_PROFILE)
      assert.ok(components.length >= 1, 'watermark stroke must be detected')
      const wm = components.find(c =>
        c.x1 >= wmBox.x0 && c.x0 <= wmBox.x1 && c.y1 >= wmBox.y0 && c.y0 <= wmBox.y1)
      assert.ok(wm, 'a passing component must overlap the watermark band')
      assert.ok((wm.x1 - wm.x0 + 1) / (wm.y1 - wm.y0 + 1) >= 3, 'watermark bbox must clear minAspect=3')
    })

    it('preContrast default guard: option-less call detects the near-grey watermark (default now ON)', () => {
      // Pins the buildLut fallback fix (#45): the documented preContrast:true default must actually
      // apply when no options are passed. bg=[128] fg=[155] is below raw-Sobel threshold (108 < 150)
      // and only crosses it after invert+contrast.
      const bg = [128, 128, 128]
      const fg = [155, 155, 155]
      const img = solid(24, 24, bg)
      plus(img, 12, 12, 7, fg)
      assert.ok(engine.detectWatermark(img).components.length >= 1,
        'default (no options) must apply preContrast:true and detect the near-grey watermark')
      assert.strictEqual(engine.detectWatermark(img, { preContrast: false }).components.length, 0,
        'explicit preContrast:false must still fall below threshold (default is not forced)')
    })

    it('new levers default to no-ops: blurRadius=0 and minAspect=0 leave option-less detection intact', () => {
      // A near-square "+" (aspect ~1) must still pass with no options — proves minAspect defaults to 0
      // (not the GUI profile's 3) and blurRadius defaults to 0 (no smoothing of the small shape).
      const img = solid(24, 24, WHITE)
      plus(img, 12, 12, 7, BLACK)
      assert.ok(engine.detectWatermark(img).components.length >= 1,
        'square shape must survive default levers (no aspect gate, no blur)')
    })
  })

  describe('detectTiling (#50)', function () {
    // [TRAP]: Synthetic comb won't form at N=256 — at 25px pitch, 25+ AC lattice peaks (x+y+diagonal
    // harmonics) compete for TOP_N=12; higher x-axis harmonics (75,100,125px) get crowded out and
    // combCount stays 2. Fix: raise to N=512 (plan option a — no COMB_MIN contract change). Engine's
    // real-image path always resolves N=512 for images >= 512px; this window matches production use.
    //
    // 512x512 field so N=512, LAG_MAX = min(200, 254) = 200.
    // pitch = floor(200/5) = 40px: harmonics at 40/80/120/160/200 — five inside [LAG_MIN=10, 200].
    this.timeout(15000) // 3 radius sweeps × N=512 2D FFT ≈ 500ms/call; 15s covers the battery
    const TILE_N = 512
    const TILE_PITCH = 40 // floor(LAG_MAX/5) with LAG_MAX=200

    // [TRAP]: A perfectly symmetric 2D dot grid (marks at every (kx*pitch, ky*pitch)) is a degenerate
    // synthetic: it generates 25 AC peaks in the upper half-plane, all entering the sort together.
    // TOP_N=12 keeps only the 12 strongest — diagonal peaks (-40,40),(80,40),(-80,80),(80,80) etc.
    // outcompete x-axis harmonics beyond lag=80px, so combCount stays 2. Real tiled watermarks (text
    // repeating in one direction) are NOT symmetric 2D grids and do not hit this. Fix: use short
    // horizontal STRIPES (3px tall, 64px wide, centred in x) — periodic in y only — which produce a
    // clean 5-peak axis-aligned y-comb well within TOP_N. TILE_N kept at 512 (plan option a).
    function solidTile (w, h, rgb) {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255
      }
      return { data, width: w, height: h }
    }
    function rectTile (img, x0, y0, x1, y1, rgb) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const o = (y * img.width + x) * 4
          img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]
        }
      }
    }
    // Short horizontal stripes: 3px tall, STRIPE_W px wide, centred in x, every pitch pixels in y.
    // Periodic in y only → axis-aligned AC comb at (0, k*pitch) — no competing 2D diagonal lattice.
    // STRIPE_W must be < W so x-neighbours have strictly lower AC (ensuring 2D local maxima).
    const STRIPE_W = 64
    function tiledStripes (img, pitch, fg, xOffset) {
      const W = img.width, H = img.height
      const x0 = Math.max(0, Math.floor(W / 2 - STRIPE_W / 2) + (xOffset || 0))
      const x1 = Math.min(W - 1, x0 + STRIPE_W - 1)
      for (let cy = Math.floor(pitch / 2); cy < H; cy += pitch) {
        rectTile(img, x0, Math.max(0, cy - 1), x1, Math.min(H - 1, cy + 1), fg)
      }
    }

    it('detects a regularly tiled synthetic mark: tiling true, combCount >= 4, period near pitch', function () {
      // Horizontal stripes periodic in y → clean axis-aligned AC comb at (0, k*TILE_PITCH).
      const img = solidTile(TILE_N, TILE_N, [200, 200, 200])
      tiledStripes(img, TILE_PITCH, [80, 80, 80])
      const r = engine.detectTiling(img)
      assert.strictEqual(r.tiling, true, `expected tiling:true, got combCount=${r.combCount} topRatio=${r.topRatio.toFixed(2)}x period=${r.period}px`)
      assert.ok(r.combCount >= 4, `combCount should be >= 4, got ${r.combCount}`)
      assert.ok(r.period > 0, 'period must be > 0')
      assert.ok(Math.abs(r.period - TILE_PITCH) / TILE_PITCH <= 0.2,
        `period ${r.period}px should be within 20% of pitch ${TILE_PITCH}px`)
    })

    it('returns tiling false on a flat field (no periodic signal)', function () {
      const img = solidTile(TILE_N, TILE_N, [128, 128, 128])
      const r = engine.detectTiling(img)
      assert.strictEqual(r.tiling, false, 'flat field must not trigger tiling detection')
      assert.strictEqual(r.combCount, 0)
    })

    it('returns tiling false on a single isolated blob (no repeating pattern)', function () {
      const img = solidTile(TILE_N, TILE_N, [200, 200, 200])
      rectTile(img, TILE_N / 2 - 8, TILE_N / 2 - 8, TILE_N / 2 + 8, TILE_N / 2 + 8, [80, 80, 80])
      const r = engine.detectTiling(img)
      assert.strictEqual(r.tiling, false, 'single blob must not be classified as tiling')
    })

    it('honours region: stripes outside the region are not detected', function () {
      // Stripes centred in the RIGHT QUARTER (xOffset=TILE_N/4). Region covers only the LEFT half.
      // The analysis window for the left-half region is centred at x=TILE_N/4 (N=256), which lands
      // in x=[0,TILE_N/2-1] — the stripes at x≈TILE_N*3/4 are outside the window.
      const img = solidTile(TILE_N, TILE_N, [200, 200, 200])
      tiledStripes(img, TILE_PITCH, [80, 80, 80], TILE_N / 4) // shift stripes to right quarter
      const rLeft = engine.detectTiling(img, { region: { x: 0, y: 0, width: TILE_N / 2, height: TILE_N } })
      assert.strictEqual(rLeft.tiling, false, 'stripes outside the region must not be detected')
    })

    it('is deterministic: identical inputs return identical results', function () {
      const img = solidTile(TILE_N, TILE_N, [200, 200, 200])
      tiledStripes(img, TILE_PITCH, [80, 80, 80])
      const r1 = engine.detectTiling(img)
      const r2 = engine.detectTiling(img)
      assert.strictEqual(r1.tiling, r2.tiling)
      assert.strictEqual(r1.combCount, r2.combCount)
      assert.strictEqual(r1.period, r2.period)
    })

    it('confidence is 0 when not tiling, and in [0,1] when tiling', function () {
      const flat = solidTile(TILE_N, TILE_N, [128, 128, 128])
      assert.strictEqual(engine.detectTiling(flat).confidence, 0, 'confidence must be 0 when tiling:false')

      const tiled = solidTile(TILE_N, TILE_N, [200, 200, 200])
      tiledStripes(tiled, TILE_PITCH, [80, 80, 80])
      const rc = engine.detectTiling(tiled)
      if (rc.tiling) {
        assert.ok(rc.confidence > 0 && rc.confidence <= 1, `confidence ${rc.confidence} must be in (0,1]`)
      }
    })

    // #53: app.js gates the NCC text fallback on `combCount < combMin` rather than a magic 5. Lock
    // that the result carries the threshold (both the empty-default and a populated result path).
    it('result carries combMin (single source of truth for the gate, #53)', function () {
      const flat = solidTile(TILE_N, TILE_N, [128, 128, 128])
      assert.strictEqual(engine.detectTiling(flat).combMin, 5, 'empty/flat result must expose combMin')
      const tiled = solidTile(TILE_N, TILE_N, [200, 200, 200])
      tiledStripes(tiled, TILE_PITCH, [80, 80, 80])
      assert.strictEqual(engine.detectTiling(tiled).combMin, 5, 'populated result must expose combMin')
    })

    // #53 [TRAP] guard: runTile() passes the SAME raw region to detectTiling and detectTextTiling, so
    // detectTiling must not mutate the region object in place (clampRegion returns a fresh bbox).
    it('does not mutate the passed region object (#53 trap guard)', function () {
      const img = solidTile(TILE_N, TILE_N, [200, 200, 200])
      const region = { x: 10, y: 20, width: 100, height: 120 }
      const snapshot = JSON.parse(JSON.stringify(region))
      engine.detectTiling(img, { region })
      assert.deepStrictEqual(region, snapshot, 'region must be untouched after detectTiling')
    })
  })

  describe('propagateMask / tileBasis (#46)', function () {
    this.timeout(15000) // round-trip runs the 3-radius N=512 FFT sweep (~500ms)

    // A filled WxH rectangle seed at (x0,y0), as a flat Uint8Array mask.
    function seedBlock (W, H, x0, y0, w, h) {
      const m = new Uint8Array(W * H)
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) m[y * W + x] = 1
      return m
    }
    function countSet (mask) { let n = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) n++; return n }

    // Horizontal stripe field (periodic in Y) — the same clean-comb synthetic the detectTiling block
    // uses, so the AC fundamental is ~ (0, pitch). Used for the basis + round-trip tests.
    function stripeField (N, pitch) {
      const data = new Uint8ClampedArray(N * N * 4)
      for (let i = 0; i < N * N; i++) { data[i * 4] = 200; data[i * 4 + 1] = 200; data[i * 4 + 2] = 200; data[i * 4 + 3] = 255 }
      const W0 = 64, x0 = Math.floor(N / 2 - W0 / 2)
      for (let cy = Math.floor(pitch / 2); cy < N; cy += pitch) {
        for (let yy = cy - 1; yy <= cy + 1; yy++) {
          if (yy < 0 || yy >= N) continue
          for (let x = x0; x < x0 + W0; x++) { const o = (yy * N + x) * 4; data[o] = 80; data[o + 1] = 80; data[o + 2] = 80 }
        }
      }
      return { data, width: N, height: N }
    }

    it('detectTiling surfaces a tileBasis whose primary magnitude ~= period when tiling', function () {
      const r = engine.detectTiling(stripeField(512, 40))
      assert.strictEqual(r.tiling, true, `expected tiling:true (combCount=${r.combCount})`)
      assert.ok(Array.isArray(r.tileBasis) && r.tileBasis.length >= 1, 'tileBasis must be non-empty when tiling')
      const mag = Math.hypot(r.tileBasis[0].x, r.tileBasis[0].y)
      assert.ok(Math.abs(mag - r.period) < 2, `|tileBasis[0]| ${mag.toFixed(1)} should ~= period ${r.period}`)
    })

    it('tileBasis vectors are sign-normalised into the canonical half-plane', function () {
      const r = engine.detectTiling(stripeField(512, 40))
      r.tileBasis.forEach(v => {
        assert.ok(v.x > 0 || (v.x === 0 && v.y > 0), `basis ${JSON.stringify(v)} not in canonical half-plane`)
      })
    })

    it('a too-small (non-analysable) image yields an empty tileBasis array', function () {
      const small = { data: new Uint8ClampedArray(32 * 32 * 4).fill(255), width: 32, height: 32 }
      assert.deepStrictEqual(engine.detectTiling(small).tileBasis, [])
    })

    it('stamps a seed across a 2-vector lattice at exactly the expected nodes', function () {
      const W = 100, H = 100
      const seed = seedBlock(W, H, 10, 10, 5, 5)
      const r = engine.propagateMask(seed, W, H, [{ x: 20, y: 0 }, { x: 0, y: 30 }])
      assert.strictEqual(r.mask[10 * W + 10], 1, 'seed node present')
      assert.strictEqual(r.mask[40 * W + 30], 1, 'node (+20,+30) present') // 10+20, 10+30
      assert.strictEqual(r.mask[10 * W + 25], 0, 'mid-gap between stamps stays 0')
      assert.ok(r.instances > 1, 'multiple instances stamped')
      assert.strictEqual(r.subharmonicWarning, false, 'well-separated lattice -> no warning')
    })

    it('clamps stamps to image bounds (no out-of-range writes, mask length preserved)', function () {
      const W = 60, H = 60
      const seed = seedBlock(W, H, 2, 2, 5, 5) // near top-left -> negative-offset stamps get clamped
      const r = engine.propagateMask(seed, W, H, [{ x: 20, y: 0 }, { x: 0, y: 20 }])
      assert.strictEqual(r.mask.length, W * H, 'mask length unchanged')
      assert.strictEqual(r.mask[2 * W + 2], 1, 'seed still present')
      assert.ok(countSet(r.mask) > 0, 'something stamped')
    })

    it('is OR-idempotent: re-running yields an identical mask + instance count', function () {
      const W = 80, H = 80
      const seed = seedBlock(W, H, 5, 5, 6, 6)
      const a = engine.propagateMask(seed, W, H, [{ x: 24, y: 0 }, { x: 0, y: 24 }])
      const b = engine.propagateMask(seed, W, H, [{ x: 24, y: 0 }, { x: 0, y: 24 }])
      assert.strictEqual(a.instances, b.instances)
      assert.deepStrictEqual(Array.from(a.mask), Array.from(b.mask))
    })

    it('degenerate / missing basis returns just the seed (instances:1)', function () {
      const W = 50, H = 50
      const seed = seedBlock(W, H, 10, 10, 4, 4)
      const r0 = engine.propagateMask(seed, W, H, [{ x: 0, y: 0 }])
      assert.strictEqual(r0.instances, 1)
      assert.strictEqual(countSet(r0.mask), 16, 'only the 4x4 seed remains')
      assert.strictEqual(engine.propagateMask(seed, W, H, []).instances, 1, 'empty basis array -> seed only')
    })

    it('empty seed returns instances:0 and an empty mask', function () {
      const W = 40, H = 40
      const r = engine.propagateMask(new Uint8Array(W * H), W, H, [{ x: 10, y: 0 }])
      assert.strictEqual(r.instances, 0)
      assert.strictEqual(countSet(r.mask), 0)
    })

    it('respects the instance cap', function () {
      const W = 120, H = 120
      const seed = seedBlock(W, H, 1, 1, 2, 2)
      const r = engine.propagateMask(seed, W, H, [{ x: 3, y: 0 }, { x: 0, y: 3 }], { maxInstances: 25 })
      assert.ok(r.instances <= 25, `instances ${r.instances} must respect cap 25`)
    })

    it('flags subharmonicWarning when the basis is shorter than the seed footprint', function () {
      const W = 80, H = 80
      const seed = seedBlock(W, H, 10, 10, 10, 10) // 10px wide
      assert.strictEqual(engine.propagateMask(seed, W, H, [{ x: 5, y: 0 }]).subharmonicWarning, true,
        'basis 5px < seed 10px -> half-period lock')
      assert.strictEqual(engine.propagateMask(seed, W, H, [{ x: 30, y: 0 }]).subharmonicWarning, false,
        'basis 30px > seed 10px -> clean')
    })

    it('round-trip: detectTiling basis fed to propagateMask reproduces the tiling', function () {
      const N = 512, pitch = 40
      const r = engine.detectTiling(stripeField(N, pitch))
      assert.strictEqual(r.tiling, true)
      // Seed = one stripe instance (64x3 block) at the first in-window stripe row.
      const seed = new Uint8Array(N * N)
      const sx = Math.floor(N / 2 - 32), sy = Math.floor(pitch / 2)
      for (let yy = sy - 1; yy <= sy + 1; yy++) for (let x = sx; x < sx + 64; x++) seed[yy * N + x] = 1
      const prop = engine.propagateMask(seed, N, N, r.tileBasis)
      assert.ok(prop.instances >= 5, `expected several stamped rows, got ${prop.instances}`)
      assert.strictEqual(prop.mask[(sy + pitch) * N + sx], 1, 'next stripe row down is covered')
      assert.strictEqual(prop.mask[(sy + 2 * pitch) * N + sx], 1, 'two rows down is covered')
    })
  })

  // detectTextTiling (#53) — template-matching (fast NCC) fallback for LETTER-FORM tiled watermarks
  // the FFT comb misses. Synthetics use a textured "glyph" (internal variance is mandatory — a flat
  // block has ~zero template energy and NCC degenerates) repeated on a regular pitch; the user's box
  // around the FIRST glyph is the region/template. See LEARNINGS CORE-20 (anisotropic NMS) + the
  // spike scripts/spike-text-tiling.js for the validated parameters.
  describe('detectTextTiling (#53)', function () {
    this.timeout(20000) // a single 2-D FFT over po2Ceil(max(W,H)); the >1024 rescale case dominates

    // Mildly textured background (deterministic pseudo-noise). A PERFECTLY flat field is pathological
    // for NCC — low-variance windows inflate correlation and spawn spurious peaks — and is unlike the
    // textured photos the spike validated against (TEST-4: match real fixture difficulty). The texture
    // keeps every window's variance non-trivial so non-glyph positions stay well below the cutoff.
    function texturedImg (W, H, base, amp) {
      const data = new Uint8ClampedArray(W * H * 4)
      for (let i = 0; i < W * H; i++) {
        const n = (((i * 2654435761) >>> 0) % (2 * amp + 1)) - amp
        const v = base + n
        data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255
      }
      return { data, width: W, height: H }
    }
    // Stamp an asymmetric "F"-like glyph (top bar + left column + mid bar): strong internal structure
    // so the template has real energy and every copy correlates ~1. Draws only the FG strokes, leaving
    // the textured background between strokes — like a real semi-transparent mark over content.
    function stampGlyph (img, x0, y0, w, h, fg) {
      const W = img.width
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!((y < 2) || (x < 2) || (y >= (h >> 1) && y < (h >> 1) + 2 && x < w * 0.7))) continue
          const o = ((y0 + y) * W + (x0 + x)) * 4
          img.data[o] = fg[0]; img.data[o + 1] = fg[1]; img.data[o + 2] = fg[2]
        }
      }
    }
    const FG = [70, 70, 70]
    function bgImg (W, H) { return texturedImg(W, H, 200, 16) }

    it('detects a vertically-tiled text mark: tiling true, instances >= 3, 1-D basis ~= pitch', function () {
      const N = 256, gw = 40, gh = 16, pitch = 44, x0 = (N >> 1) - (gw >> 1)
      const img = bgImg(N, N)
      for (let cy = 22; cy + gh < N; cy += pitch) stampGlyph(img, x0, cy, gw, gh, FG)
      const r = engine.detectTextTiling(img, { x: x0, y: 22, width: gw, height: gh })
      assert.strictEqual(r.tiling, true, `expected tiling:true (instances=${r.instances})`)
      assert.ok(r.instances >= 3, `instances should be >= 3, got ${r.instances}`)
      assert.ok(Array.isArray(r.tileBasis) && r.tileBasis.length >= 1, 'tileBasis must be non-empty when tiling')
      const mag = Math.hypot(r.tileBasis[0].x, r.tileBasis[0].y)
      assert.ok(Math.abs(mag - pitch) / pitch <= 0.15, `|tileBasis[0]| ${mag.toFixed(1)} should ~= pitch ${pitch}`)
    })

    it('tileBasis vectors are canonical (+x half-plane) and confidence is in (0,1] when tiling', function () {
      const N = 256, gw = 40, gh = 16, pitch = 44, x0 = (N >> 1) - (gw >> 1)
      const img = bgImg(N, N)
      for (let cy = 22; cy + gh < N; cy += pitch) stampGlyph(img, x0, cy, gw, gh, FG)
      const r = engine.detectTextTiling(img, { x: x0, y: 22, width: gw, height: gh })
      r.tileBasis.forEach(v => assert.ok(v.x > 0 || (v.x === 0 && v.y > 0), `basis ${JSON.stringify(v)} not canonical`))
      assert.ok(r.confidence > 0 && r.confidence <= 1, `confidence ${r.confidence} must be in (0,1]`)
    })

    it('returns tiling false (and confidence 0) on a clean field with no repeats', function () {
      const img = bgImg(256, 256)
      stampGlyph(img, 108, 120, 40, 16, FG) // a SINGLE glyph — no tiling
      const r = engine.detectTextTiling(img, { x: 108, y: 120, width: 40, height: 16 })
      assert.strictEqual(r.tiling, false, 'a single isolated glyph must not latch a lattice')
      assert.deepStrictEqual(r.tileBasis, [])
      assert.strictEqual(r.confidence, 0)
    })

    it('rescales the basis to full-image pixels when the frame is downscaled (>1024px)', function () {
      // 1200px wide forces the WORK_MAX=1024 downscale (scale=0.853). Glyphs tiled HORIZONTALLY at
      // 200px pitch; the working-coord pitch (~171px) must be rescaled back to ~200px on return —
      // the #53 regression that would stamp at the wrong spacing on large images.
      const W = 1200, H = 360, gw = 40, gh = 16, pitchX = 200, y0 = (H >> 1) - (gh >> 1)
      const img = bgImg(W, H)
      for (let cx = 100; cx + gw < W; cx += pitchX) stampGlyph(img, cx, y0, gw, gh, FG)
      const r = engine.detectTextTiling(img, { x: 100, y: y0, width: gw, height: gh })
      assert.strictEqual(r.tiling, true, `expected tiling:true (instances=${r.instances})`)
      const mag = Math.hypot(r.tileBasis[0].x, r.tileBasis[0].y)
      assert.ok(Math.abs(mag - pitchX) / pitchX <= 0.15,
        `rescaled |tileBasis[0]| ${mag.toFixed(1)} should ~= full-res pitch ${pitchX} (not the ~171 working pitch)`)
    })

    it('is deterministic and does not crash on a noisy clean image (smoke)', function () {
      const N = 200, img = texturedImg(N, N, 128, 40) // noisy, no repeating mark
      const a = engine.detectTextTiling(img, { x: 80, y: 80, width: 40, height: 20 })
      const b = engine.detectTextTiling(img, { x: 80, y: 80, width: 40, height: 20 })
      assert.strictEqual(a.tiling, b.tiling, 'identical inputs -> identical verdict')
      assert.strictEqual(typeof a.tiling, 'boolean')
      assert.ok(Array.isArray(a.tileBasis))
    })

    it('returns empty for a degenerately small template box', function () {
      const img = bgImg(128, 128)
      const r = engine.detectTextTiling(img, { x: 10, y: 10, width: 2, height: 2 }) // < MIN_TEMPLATE
      assert.strictEqual(r.tiling, false)
      assert.deepStrictEqual(r.tileBasis, [])
    })

    // #58 — global lattice fit: position-invariant 2-D basis (the 6-vs-76 fix) + fragment-seed
    // rejection. A 2-D grid mirrors the TAYLOR GALE fixture shape: multiple rows AND columns so the
    // old seed-local NN v1 heuristic had somewhere to diverge.
    function boxMask (W, H, s) {
      const m = new Uint8Array(W * H)
      const x1 = Math.min(W, s.x + s.width), y1 = Math.min(H, s.y + s.height)
      for (let y = s.y; y < y1; y++) for (let x = s.x; x < x1; x++) m[y * W + x] = 1
      return m
    }
    // NOTE: the canvas is sized to just barely exceed the drawn grid (tight margins on the last
    // row/col). propagateMask deliberately extrapolates lattice nodes across the WHOLE frame
    // (by design — it stamps predicted/occluded instances too, LEARNINGS/#46), so a canvas much
    // larger than the drawn grid would legitimately produce MORE stamps than "true tiles" without
    // that being a bug. Tight margins keep the true grid count a meaningful upper bound.
    function gridImg () {
      const gw = 30, gh = 14, pitchX = 60, pitchY = 50
      const cols = 4, rows = 5
      const W = 10 + (cols - 1) * pitchX + gw + 5
      const H = 10 + (rows - 1) * pitchY + gh + 5
      const img = bgImg(W, H)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) stampGlyph(img, 10 + c * pitchX, 10 + r * pitchY, gw, gh, FG)
      }
      return { img, gw, gh, pitchX, pitchY, cols, rows }
    }
    function sortBasis (basis) {
      return basis.map(v => v.x + ',' + v.y).sort().join(' | ')
    }

    it('#58 position invariance: boxing different valid instances on the same grid yields the SAME basis', function () {
      const g = gridImg()
      const seedA = { x: 10 + 1 * g.pitchX, y: 10 + 1 * g.pitchY, width: g.gw, height: g.gh } // (col1,row1)
      const seedB = { x: 10 + 2 * g.pitchX, y: 10 + 3 * g.pitchY, width: g.gw, height: g.gh } // (col2,row3)
      const rA = engine.detectTextTiling(g.img, seedA)
      const rB = engine.detectTextTiling(g.img, seedB)
      assert.strictEqual(rA.tiling, true, 'seed A should tile')
      assert.strictEqual(rB.tiling, true, 'seed B should tile')
      assert.strictEqual(sortBasis(rA.tileBasis), sortBasis(rB.tileBasis),
        `basis must be position-invariant: A=${JSON.stringify(rA.tileBasis)} B=${JSON.stringify(rB.tileBasis)}`)
      assert.strictEqual(rA.instances, rB.instances, 'peak count should also match across seed positions')
    })

    it('#58 no subharmonic over-stamp: propagateMask instance count does not exceed the true grid size', function () {
      const g = gridImg()
      const seed = { x: 10 + 1 * g.pitchX, y: 10 + 1 * g.pitchY, width: g.gw, height: g.gh }
      const r = engine.detectTextTiling(g.img, seed)
      assert.strictEqual(r.tiling, true)
      const mask = boxMask(g.img.width, g.img.height, seed)
      const prop = engine.propagateMask(mask, g.img.width, g.img.height, r.tileBasis)
      const trueCount = g.cols * g.rows
      assert.ok(prop.instances <= trueCount,
        `stamped ${prop.instances} instances but the grid only has ${trueCount} — subharmonic over-stamp`)
      assert.strictEqual(prop.subharmonicWarning, false, 'a correctly-fit basis should not flag subharmonic')
    })

    // ---- real-fixture: the exact 6-vs-76 bug + fragment over-stamp from the #58 spike -----------
    // repeated-tile-template.jpg is the TAYLOR GALE fixture the spike validated against (GO,
    // scripts/evidence/spike-lattice-58/results.txt). Seed coords are the spike's own probe seeds.
    it('#58 real fixture: boxing TAYLOR at two different rows yields the SAME basis (the 6-vs-76 fix)', async function () {
      const _Jimp = require('jimp'); const Jimp = _Jimp.default || _Jimp // CORE-1: ESM/CJS interop
      const jimg = await Jimp.read('./test/files/repeated-tile-template.jpg')
      const img = { data: jimg.bitmap.data, width: jimg.bitmap.width, height: jimg.bitmap.height }
      const seedR1 = { x: 330, y: 32, width: 150, height: 46 } // spike: 'r1 mid TAYLOR'
      const seedR3 = { x: 330, y: 268, width: 150, height: 46 } // spike: 'r3 mid TAYLOR'
      const rA = engine.detectTextTiling(img, seedR1)
      const rB = engine.detectTextTiling(img, seedR3)
      assert.strictEqual(rA.tiling, true, 'TAYLOR row 1 should tile')
      assert.strictEqual(rB.tiling, true, 'TAYLOR row 3 should tile')
      assert.strictEqual(sortBasis(rA.tileBasis), sortBasis(rB.tileBasis),
        `basis must be position-invariant on the real fixture: A=${JSON.stringify(rA.tileBasis)} B=${JSON.stringify(rB.tileBasis)}`)
    })

    it('#58 real fixture: fragment seeds (LOR slice / letter O) no longer over-stamp — rejected as non-tiling', async function () {
      const _Jimp = require('jimp'); const Jimp = _Jimp.default || _Jimp
      const jimg = await Jimp.read('./test/files/repeated-tile-template.jpg')
      const img = { data: jimg.bitmap.data, width: jimg.bitmap.width, height: jimg.bitmap.height }
      const lorSlice = { x: 372, y: 32, width: 70, height: 46 } // spike: over-stamped to 60 on the old engine
      const letterO = { x: 388, y: 32, width: 34, height: 46 } // spike: over-stamped to 30 on the old engine
      const rLor = engine.detectTextTiling(img, lorSlice)
      const rO = engine.detectTextTiling(img, letterO)
      assert.strictEqual(rLor.tiling, false, `LOR slice fragment must be rejected, got basis ${JSON.stringify(rLor.tileBasis)}`)
      assert.strictEqual(rO.tiling, false, `letter-O fragment must be rejected, got basis ${JSON.stringify(rO.tileBasis)}`)
    })
  })

  // Anchor -> propagate (#47, T29 Phase 3 DoD). Two gaps remained after #52 shipped the FFT
  // propagate/confirm machinery: (1) the confirm card needs the lattice geometry (rows/cols), and
  // (2) a regression test proving anchor->propagate recovers tiled instances a per-blob pass misses.
  // The recovery + baseline-gap math runs on a controlled 1-D-dominant synthetic (ground-truth
  // positions, fully deterministic); a real-PNG smoke test guards the detect->propagate wiring on real
  // FFT noise. copyright-watermark.png returns tiling:false whole-image with no instance annotations,
  // so it CANNOT carry the recovery assertion — that is why the synthetic owns the >=80% claim.
  describe('anchor -> propagate (#47)', function () {
    this.timeout(15000) // detectTiling on the synthetic + the real PNG each run the N=512 FFT sweep

    function seedBlock (W, H, x0, y0, w, h) {
      const m = new Uint8Array(W * H)
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) m[y * W + x] = 1
      return m
    }

    // ---- rows/cols: count DISTINCT in-bounds lattice lines (cols along v0, rows along v1) ----
    it('reports cols along v0 and rows along v1 for a 2-D lattice', function () {
      const W = 200, H = 200
      const r = engine.propagateMask(seedBlock(W, H, 5, 5, 4, 4), W, H, [{ x: 40, y: 0 }, { x: 0, y: 50 }])
      assert.ok(r.cols >= 2 && r.rows >= 2, `expected a 2-D grid, got rows=${r.rows} cols=${r.cols}`)
      assert.ok(r.instances <= r.rows * r.cols, 'in-bounds stamps cannot exceed rows*cols')
    })

    it('collapses rows to 1 for a 1-D basis (cols === instances)', function () {
      const W = 200, H = 60
      const r = engine.propagateMask(seedBlock(W, H, 5, 25, 6, 6), W, H, [{ x: 25, y: 0 }])
      assert.strictEqual(r.rows, 1, '1-D basis -> a single row')
      assert.strictEqual(r.cols, r.instances, 'cols must equal instances for a single line')
    })

    it('counts only in-bounds lattice lines (edge-clipped seed)', function () {
      const W = 80, H = 80
      const r = engine.propagateMask(seedBlock(W, H, 2, 2, 4, 4), W, H, [{ x: 20, y: 0 }, { x: 0, y: 20 }])
      assert.ok(r.rows >= 1 && r.cols >= 1, 'at least the seed line in each axis')
      assert.ok(r.rows * r.cols >= r.instances, 'rows*cols bounds the in-bounds stamp count')
    })

    it('empty seed -> rows:0 cols:0; degenerate/empty basis -> rows:1 cols:1', function () {
      const W = 40, H = 40
      const empty = engine.propagateMask(new Uint8Array(W * H), W, H, [{ x: 10, y: 0 }])
      assert.strictEqual(empty.rows, 0); assert.strictEqual(empty.cols, 0)
      const degen = engine.propagateMask(seedBlock(W, H, 10, 10, 4, 4), W, H, [])
      assert.strictEqual(degen.rows, 1); assert.strictEqual(degen.cols, 1)
    })

    // ---- synthetic recovery: anchor->propagate recovers faint instances a per-blob pass misses ----
    // A 1-D-dominant row of ST "E"-like thin glyphs at period SP. Glyph 0 is the bright ANCHOR; the
    // rest are faint (stroke ~205 on a 230 background) so detectWatermark's edge gate misses them.
    // NOT a 2-D dot grid (CORE-17 would crowd the comb out and return tiling:false).
    const SN = 512, SBG = 230, SP = 32, SX0 = 40, SY = 256, ST = 12, GW = 16, GH = 20
    function mkField () {
      const d = new Uint8ClampedArray(SN * SN * 4)
      for (let i = 0; i < SN * SN; i++) { d[i * 4] = SBG; d[i * 4 + 1] = SBG; d[i * 4 + 2] = SBG; d[i * 4 + 3] = 255 }
      return { data: d, width: SN, height: SN }
    }
    function drawGlyph (img, gx, gy, v) {
      const d = img.data
      const set = (x, y) => { const o = (y * SN + x) * 4; d[o] = v; d[o + 1] = v; d[o + 2] = v }
      for (let y = gy; y < gy + GH; y++) { set(gx, y); set(gx + 1, y) }                                  // left vertical stroke (2px)
      for (const bar of [gy, gy + (GH >> 1), gy + GH - 2]) for (let x = gx; x < gx + GW; x++) { set(x, bar); set(x, bar + 1) } // 3 horizontal bars
    }
    function buildTiledField () {
      const img = mkField(); const positions = []
      for (let k = 0; k < ST; k++) { const gx = SX0 + k * SP; positions.push(gx); drawGlyph(img, gx, SY, k === 0 ? 60 : 205) }
      return { img, positions }
    }
    function anchorMask () { // exact pixels of ONE full-intensity glyph at the anchor position
      const m = new Uint8Array(SN * SN); const tmp = mkField(); drawGlyph(tmp, SX0, SY, 60)
      for (let i = 0; i < SN * SN; i++) if (tmp.data[i * 4] < 150) m[i] = 1
      return m
    }
    function coveredPositions (mask, positions) {
      let n = 0
      for (const gx of positions) {
        let hit = false
        for (let y = SY; y <= SY + GH && !hit; y++) for (let x = gx; x <= gx + GW; x++) { if (mask[y * SN + x]) { hit = true; break } }
        if (hit) n++
      }
      return n
    }

    it('baseline gap: a per-blob pass (detectWatermark) recovers < 0.6T of the tiled instances', function () {
      const { img, positions } = buildTiledField()
      const dw = engine.detectWatermark(img, { edgeThreshold: 150, preContrast: false })
      let found = 0
      for (const gx of positions) {
        if (dw.components.some(c => c.x1 >= gx && c.x0 <= gx + GW && c.y1 >= SY && c.y0 <= SY + GH)) found++
      }
      assert.ok(found < 0.6 * ST, `Phase-2 baseline must miss the faint majority: found ${found}/${ST} (ceiling ${(0.6 * ST).toFixed(1)})`)
    })

    it('recovery: anchor + propagate covers >= 80% of the tiled instances (incl. faint ones)', function () {
      const { positions } = buildTiledField()
      const prop = engine.propagateMask(anchorMask(), SN, SN, [{ x: SP, y: 0 }]) // ground-truth basis -> deterministic
      const recovered = coveredPositions(prop.mask, positions)
      assert.ok(recovered >= 0.8 * ST, `expected >= 80% recovery, got ${recovered}/${ST} (floor ${(0.8 * ST).toFixed(1)})`)
    })

    it('detectTiling recovers the synthetic period (the comb is real, not a trivially-clean signal)', function () {
      const t = engine.detectTiling(buildTiledField().img)
      assert.strictEqual(t.tiling, true, `expected tiling:true, got combCount=${t.combCount}`)
      assert.ok(Math.abs(t.period - SP) <= 2, `period ${t.period} should ~= ${SP}`)
    })

    // ---- real-fixture smoke: detect->propagate wiring survives real FFT noise ----
    it('real fixture: detectTiling yields a non-degenerate basis that propagates without crashing', async function () {
      const _Jimp = require('jimp'); const Jimp = _Jimp.default || _Jimp // CORE-1: ESM/CJS interop
      const jimg = await Jimp.read('./test/files/copyright-watermark.png')
      const W = jimg.bitmap.width, H = jimg.bitmap.height
      const t = engine.detectTiling({ data: jimg.bitmap.data, width: W, height: H })
      assert.ok(Array.isArray(t.tileBasis) && t.tileBasis.length >= 1, 'expected a non-empty tileBasis on a real tiled image')
      const mag = Math.hypot(t.tileBasis[0].x, t.tileBasis[0].y)
      assert.ok(mag >= 2 && t.period > 0 && t.period < 200, `basis non-degenerate & period plausible (mag=${mag.toFixed(1)} period=${t.period})`)
      // Feed the REAL basis to propagateMask with a small synthetic seed (< period, avoids the
      // sub-harmonic artifact) — proves detect->propagate wiring holds on a real-sized image.
      const prop = engine.propagateMask(seedBlock(W, H, (W / 2) | 0, (H / 2) | 0, 8, 8), W, H, t.tileBasis)
      assert.strictEqual(prop.mask.length, W * H, 'mask length preserved on a real-sized image')
      assert.ok(prop.instances > 1, `real basis should stamp multiple instances, got ${prop.instances}`)
    })
  })

  // fillMaskRegion (#52) — inpaint an arbitrary supplied mask, reusing smartFill's dilation + #31
  // guard + BFS geodesic core. The parity test is the regression gate for the Step-1 extraction:
  // a mask equal to smartFill's colour-match mask must reconstruct byte-identical pixels.
  describe('fillMaskRegion (#52)', function () {
    const T = [200, 0, 0] // "watermark" colour to remove
    const A = [0, 100, 0] // background

    // Mark every pixel exactly equal to `colour` in a {data,width,height} buffer.
    function colourMask (img, colour) {
      const m = new Uint8Array(img.width * img.height)
      for (let p = 0; p < m.length; p++) {
        const o = p * 4
        if (img.data[o] === colour[0] && img.data[o + 1] === colour[1] && img.data[o + 2] === colour[2]) m[p] = 1
      }
      return m
    }

    it('reconstructs a supplied shape mask from the surrounding background (unfilled 0)', () => {
      const img = makeGrid([
        [A, A, A, A, A],
        [A, T, T, T, A],
        [A, T, T, T, A],
        [A, T, T, T, A],
        [A, A, A, A, A]
      ])
      const r = engine.fillMaskRegion(img, colourMask(img, T))
      assert.strictEqual(r.unfilled, 0)
      assert.strictEqual(r.filled, 9, 'all 9 masked pixels reconstructed')
      assert.deepStrictEqual(pixelAt(img, 2, 2).slice(0, 3), A, 'centre reconstructed from background')
    })

    it('is byte-identical to smartFill given smartFill\'s colour-match mask (extraction parity)', () => {
      const rows = [
        [A, A, A, A, A],
        [A, T, T, T, A],
        [A, T, A, T, A],
        [A, T, T, T, A],
        [A, A, A, A, A]
      ]
      const viaSmart = makeGrid(rows)
      const viaMask = makeGrid(rows)
      engine.smartFill(viaSmart, T, 0) // tol 0 -> matches exactly the T pixels
      engine.fillMaskRegion(viaMask, colourMask(viaMask, T))
      assert.deepStrictEqual(Array.from(viaMask.data), Array.from(viaSmart.data))
    })

    it('honours dilate: expands the fill set so an anti-aliased fringe is reconstructed', () => {
      const B = [0, 0, 100]   // 1px fringe ring (NOT in the mask)
      const C = [100, 0, 100] // true background just outside the fringe
      const grid = () => makeGrid([
        [A, A, A, A, A, A, A],
        [A, C, C, C, C, C, A],
        [A, C, B, B, B, C, A],
        [A, C, B, T, B, C, A],
        [A, C, B, B, B, C, A],
        [A, C, C, C, C, C, A],
        [A, A, A, A, A, A, A]
      ])
      const noDil = grid()
      const r0 = engine.fillMaskRegion(noDil, colourMask(noDil, T))
      assert.strictEqual(r0.filled, 1)
      assert.deepStrictEqual(pixelAt(noDil, 3, 3).slice(0, 3), B, 'no dilation -> centre takes the fringe (halo)')

      const dil = grid()
      const r1 = engine.fillMaskRegion(dil, colourMask(dil, T), { dilate: 1 })
      assert.ok(r1.filled > 1, 'dilation pulls the fringe ring into the fill set')
      assert.deepStrictEqual(pixelAt(dil, 3, 3).slice(0, 3), C, 'centre now samples past the fringe')
      assert.deepStrictEqual(pixelAt(dil, 3, 2).slice(0, 3), C, 'a fringe pixel was reconstructed')
    })

    it('maxFillRatio guard trips on a near-full mask: skipped + buffer untouched', () => {
      const img = makeGrid([
        [T, T, T],
        [T, T, T],
        [T, A, T]
      ]) // 8/9 masked > 0.8
      const before = new Uint8ClampedArray(img.data)
      const r = engine.fillMaskRegion(img, colourMask(img, T), { maxFillRatio: 0.8 })
      assert.strictEqual(r.skipped, true)
      assert.strictEqual(r.filled, 0)
      assert.deepStrictEqual(Array.from(img.data), Array.from(before), 'buffer left untouched on skip')
    })

    it('empty mask is a no-op (filled 0, buffer unchanged)', () => {
      const img = makeGrid([[A, A, A], [A, A, A]])
      const before = new Uint8ClampedArray(img.data)
      const r = engine.fillMaskRegion(img, new Uint8Array(img.width * img.height))
      assert.strictEqual(r.filled, 0)
      assert.strictEqual(r.unfilled, 0)
      assert.deepStrictEqual(Array.from(img.data), Array.from(before))
    })

    it('region confines the fill: a masked pixel outside the rect is left untouched', () => {
      const img = makeGrid([
        [A, A, A, A],
        [A, T, A, T],
        [A, A, A, A]
      ])
      // region covers only the left columns (x 0..2). The right T at (3,1) is outside -> untouched.
      const r = engine.fillMaskRegion(img, colourMask(img, T), {}, { x: 0, y: 0, width: 3, height: 3 })
      assert.deepStrictEqual(pixelAt(img, 1, 1).slice(0, 3), A, 'in-region target reconstructed')
      assert.deepStrictEqual(pixelAt(img, 3, 1).slice(0, 3), T, 'out-of-region target left as-is')
      assert.strictEqual(r.filled, 1, 'only the in-region pixel counted')
    })

    it('mutates in place and returns the same buffer', () => {
      const img = makeGrid([[A, T, A]])
      const r = engine.fillMaskRegion(img, colourMask(img, T))
      assert.strictEqual(r.imageData, img)
    })
  })
})
