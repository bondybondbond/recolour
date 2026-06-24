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
})
