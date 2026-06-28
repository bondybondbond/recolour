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
})
