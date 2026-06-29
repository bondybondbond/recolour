#!/usr/bin/env node
/*
 * generate-tiling-fixtures.js — synthetic-but-JPEG-compressed tiled-watermark fixtures (#51 / #46).
 *
 *   node scripts/generate-tiling-fixtures.js
 *
 * WHY THIS EXISTS
 *   #51 asks whether detectTiling()'s COMB_MIN=5 gate is overfit to the current positives. The
 *   clean-ImageData synthetics in test/engine.js are too EASY — they carry no compression noise. Real
 *   watermarked photos are JPEGs, and JPEG's 8x8 DCT erodes the autocorrelation comb. So we draw a
 *   regular periodic field, then ENCODE THROUGH REAL JPEG at varying quality / resolution / angle. The
 *   result carries genuine DCT artifacts — a meaningfully harder margin test than clean synthetics,
 *   along the compression / resolution / repeat-count / angle axes. (Per the plan's #51 honesty rule
 *   these still do NOT substitute for truly-wild watermark images.)
 *
 * WHY STRIPES, NOT A 2-D GRID OF MARKS
 *   detectTiling()'s combScore gates on a COLLINEAR harmonic comb (>= COMB_MIN peaks at k*fundamental
 *   in ONE direction). A symmetric 2-D dot grid is a degenerate input here: it produces ~25 competing
 *   AC lattice peaks (x + y + diagonal harmonics) that crowd the higher axis harmonics out of TOP_N,
 *   so combCount collapses to ~2 even with a huge top-ratio (confirmed empirically + the [TRAP] note at
 *   test/engine.js:653). Real tiled watermarks present a DOMINANT comb direction; a 1-D-periodic stripe
 *   field reproduces that cleanly and isolates the one variable #51 cares about — the comb count under
 *   compression. The DIAGONAL variant gives a non-axis-aligned fundamental, exercising #46's
 *   tileBasis on a sheared lattice without the 2-D-grid competition.
 *
 *   Pitches are sized for ~5-6 clean harmonics inside [LAG_MIN=10, min(200, N/2-2)] so JPEG compression
 *   (not a starved harmonic count) is what pushes toward the gate. N = largest po2 <= min(side, 512).
 *
 * Output: writes JPEGs into test/files/ (committed fixtures; the verify harness decodes them — they
 * are NOT part of `npm test`).
 */
'use strict'

var path = require('path')
var _Jimp = require('jimp')
var Jimp = _Jimp.default || _Jimp // CORE-1: CJS vs ESM

var OUT = path.join(__dirname, '..', 'test', 'files')

// Paint a periodic stripe field at angle `theta` (radians), period `pitch`, line thickness `thick`,
// in `fg` (0xRRGGBB). A pixel is marked when its projection onto the stripe normal lands in the first
// `thick` px of each `pitch` interval. theta=0 -> horizontal stripes (periodic in y); theta=PI/4 ->
// diagonal stripes (fundamental AC vector along the diagonal). `crop` restricts to the central
// [crop, 1-crop] fraction (partial/cropped tiling).
function paintStripes (img, opt) {
  var data = img.bitmap.data, W = img.bitmap.width, H = img.bitmap.height
  var fg = opt.fg, pitch = opt.pitch, thick = opt.thick, crop = opt.crop || 0
  var nx = Math.cos(opt.theta), ny = Math.sin(opt.theta) // stripe normal
  var r = (fg >> 16) & 0xff, g = (fg >> 8) & 0xff, b = fg & 0xff
  var x0 = crop * W, x1 = (1 - crop) * W, y0 = crop * H, y1 = (1 - crop) * H
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      if (x < x0 || x > x1 || y < y0 || y > y1) continue
      var proj = x * nx + y * ny
      var m = ((proj % pitch) + pitch) % pitch
      if (m < thick) {
        var o = (y * W + x) * 4
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255
      }
    }
  }
}

var BG = 0xefefef // light grey background (mimics a near-white photo region)
var FG = 0x6f6f6f // mid-dark grey mark (faint-ish, survives moderate compression)

var FIXTURES = [
  {
    file: 'gen-diagonal-stripes.jpg',
    W: 512, H: 512, quality: 60,
    // Diagonal (45deg) stripes -> a NON-axis-aligned fundamental AC vector; the #46 tileBasis case.
    theta: Math.PI / 4, pitch: 36, thick: 4, fg: FG,
    note: '512px diagonal 45deg stripes, q60 — non-axis tileBasis fixture'
  },
  {
    file: 'gen-heavy-compression-partial.jpg',
    W: 512, H: 512, quality: 18,
    // Horizontal stripes in the central 70% only (partial/cropped) + brutal q18 compression.
    theta: 0, pitch: 40, thick: 5, fg: FG, crop: 0.15,
    note: 'partial/cropped central horizontal stripes, q18 heavy compression'
  },
  {
    file: 'gen-lowres-fewrepeats.jpg',
    W: 256, H: 256, quality: 50,
    // 256px -> N=256, lagMax=126; pitch 24 -> harmonics 24/48/72/96/120 = 5 inside the annulus.
    theta: 0, pitch: 24, thick: 3, fg: FG,
    note: 'low-resolution 256px (N=256, tight annulus), q50, near comb floor'
  }
]

;(async function () {
  console.log('generate-tiling-fixtures.js — writing JPEG-compressed tiling fixtures to test/files/')
  for (var k = 0; k < FIXTURES.length; k++) {
    var f = FIXTURES[k]
    var img = await Jimp.create(f.W, f.H, ((BG << 8) | 0xff) >>> 0) // 0xRRGGBBAA (unsigned)
    paintStripes(img, f)
    img.quality(f.quality)
    var outPath = path.join(OUT, f.file)
    await img.writeAsync(outPath)
    console.log('  wrote ' + f.file + '  (' + f.W + 'x' + f.H + ', q' + f.quality + ') — ' + f.note)
  }
  console.log('done.')
})().catch(function (e) { console.error(e); process.exit(1) })
