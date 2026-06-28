#!/usr/bin/env node
/*
 * Calibration harness for detectWatermark heuristics (#45 / T29 Phase 2).
 *
 *   node scripts/calibrate-detect.js
 *
 * Decodes the real JPEG fixtures via jimp + builds an adversarial in-memory synthetic
 * (light text over a dense, regularly-tiled mid-frequency texture field), then sweeps the
 * detection levers and prints a per-fixture table of candidate-region counts. The goal: find a
 * config that keeps the watermark text while dropping photographic-texture false positives
 * (DoD: <= ~10 regions per fixture, watermark always included).
 *
 * Sweep axes (outermost first): blurRadius x edgeThreshold x preContrast x minAspect.
 * Pre-blur is outermost because it is the single most effective lever for photo texture.
 *
 * This script is NOT part of `npm test` — it is the reproducible evidence tool the DoD references.
 *
 * #45 CONCLUSION (bail-out): the sweep's lone all-fixture "winner" passes only because its synthetic
 * watermark is HIGH-CONTRAST. GUI verification on the real WhatsApp photos showed the surviving
 * candidates land on faces/uniforms, not the faint tiled watermark (mask 2-30% light vs 54% on the
 * high-contrast watermark.jpg). Edge-detection + static thresholds cannot isolate a faint tiled
 * watermark from photographic content; its separable signal is the regular TILING -> frequency domain
 * (FFT). Detection quality is re-scoped to a follow-up FFT ticket. This harness stays as the evidence
 * tool + a regression guard against the old 100+-false-positive default.
 */
'use strict'

var path = require('path')
var _Jimp = require('jimp')
var Jimp = _Jimp.default || _Jimp // CORE-1: CJS vs ESM
var engine = require('../web/recolour-engine')

var FIX = path.join(__dirname, '..', 'test', 'files')

// ---- sweep axes -----------------------------------------------------------------------------
var BLUR = [0, 1, 2]
var THRESH = [100, 150, 200, 300]
var PRECONTRAST = [false, true]
var ASPECT = [0, 2, 3]
var DOD_MAX = 10 // <= ~10 candidate regions per fixture

// ---- adversarial synthetic fixture ----------------------------------------------------------
// Deterministic. A dense regularly-tiled mid-frequency texture (cell-based brightness variation +
// gradient) approximating the WhatsApp difficulty, with a stamped wide light-text band as the
// "watermark". wmBox is the band's bbox so we can check the watermark survives.
function makeSynthetic () {
  var w = 260, h = 180
  var data = new Uint8ClampedArray(w * h * 4)
  function hash (x, y) { var v = (x * 73856093) ^ (y * 19349663); v = (v ^ (v >> 13)) >>> 0; return v % 256 }
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var o = (y * w + x) * 4
      var grad = 60 + Math.round((y / h) * 120) // vertical gradient 60..180
      // mid-frequency tiling: 4px cells alternating brightness + per-cell jitter
      var cell = (((x >> 2) + (y >> 2)) & 1) ? 22 : -22
      var jitter = (hash(x >> 2, y >> 2) - 128) >> 3 // ~ +-16, constant within a cell
      var base = grad + cell + jitter
      if (base < 0) base = 0; if (base > 230) base = 230
      data[o] = data[o + 1] = data[o + 2] = base
      data[o + 3] = 255
    }
  }
  // Watermark: a horizontal band of light "words" (wide strokes with gaps) near the middle.
  var by0 = 80, by1 = 96, words = [[20, 70], [80, 140], [150, 230]]
  for (var wi = 0; wi < words.length; wi++) {
    for (var ty = by0; ty < by1; ty++) {
      for (var tx = words[wi][0]; tx < words[wi][1]; tx++) {
        // dashed strokes so the band reads as text (high perimeter), not a solid block
        if (((tx + ty) & 3) === 0) continue
        var oo = (ty * w + tx) * 4
        data[oo] = data[oo + 1] = data[oo + 2] = 245
      }
    }
  }
  return { data: data, width: w, height: h, wmBox: { x0: 20, y0: by0, x1: 230, y1: by1 } }
}

function decode (file) {
  return Jimp.read(path.join(FIX, file)).then(function (im) {
    return { data: im.bitmap.data, width: im.bitmap.width, height: im.bitmap.height }
  })
}

// Does any passing component overlap the known watermark band? (synthetic only)
function watermarkHit (components, wmBox) {
  for (var i = 0; i < components.length; i++) {
    var c = components[i]
    if (c.x1 >= wmBox.x0 && c.x0 <= wmBox.x1 && c.y1 >= wmBox.y0 && c.y0 <= wmBox.y1) return true
  }
  return false
}

function sweepFixture (name, img, wmBox) {
  console.log('\n=== ' + name + '  (' + img.width + 'x' + img.height + ') ===')
  console.log('blur thr  pc    aspect  count   wmHit')
  var rows = []
  BLUR.forEach(function (blurRadius) {
    THRESH.forEach(function (edgeThreshold) {
      PRECONTRAST.forEach(function (preContrast) {
        ASPECT.forEach(function (minAspect) {
          var opt = { blurRadius: blurRadius, edgeThreshold: edgeThreshold, preContrast: preContrast, minAspect: minAspect }
          var res = engine.detectWatermark(img, opt)
          var count = res.components.length
          var hit = wmBox ? watermarkHit(res.components, wmBox) : '-'
          rows.push({ blurRadius: blurRadius, edgeThreshold: edgeThreshold, preContrast: preContrast, minAspect: minAspect, count: count, hit: hit })
          console.log(
            String(blurRadius).padEnd(5) +
            String(edgeThreshold).padEnd(5) +
            String(preContrast).padEnd(6) +
            String(minAspect).padEnd(8) +
            String(count).padEnd(8) +
            String(hit)
          )
        })
      })
    })
  })
  return rows
}

(async function () {
  var fixtures = [
    { name: 'watermark.jpg', img: await decode('watermark.jpg'), wmBox: null },
    { name: 'WhatsApp .19', img: await decode('WhatsApp Image 2026-06-23 at 19.34.19.jpeg'), wmBox: null },
    { name: 'WhatsApp .50', img: await decode('WhatsApp Image 2026-06-23 at 19.34.50.jpeg'), wmBox: null }
  ]
  var syn = makeSynthetic()
  fixtures.push({ name: 'synthetic (adversarial)', img: { data: syn.data, width: syn.width, height: syn.height }, wmBox: syn.wmBox })

  var perFixtureRows = {}
  for (var i = 0; i < fixtures.length; i++) {
    perFixtureRows[fixtures[i].name] = sweepFixture(fixtures[i].name, fixtures[i].img, fixtures[i].wmBox)
  }

  // Cross-fixture: find configs where EVERY fixture is <= DOD_MAX AND the synthetic keeps its
  // watermark. These are the candidate defaults.
  console.log('\n=== configs satisfying DoD on ALL fixtures (count <= ' + DOD_MAX + ', synthetic wmHit) ===')
  var keys = Object.keys(perFixtureRows)
  var base = perFixtureRows[keys[0]]
  var winners = []
  base.forEach(function (r, idx) {
    var ok = true
    var counts = []
    keys.forEach(function (k) {
      var row = perFixtureRows[k][idx]
      counts.push(k.split(' ')[0] + ':' + row.count)
      // Every fixture here contains a watermark, so count===0 is a MISS (watermark lost), not a win.
      if (row.count < 1 || row.count > DOD_MAX) ok = false
      if (k.indexOf('synthetic') === 0 && row.hit !== true) ok = false
    })
    if (ok) winners.push({ cfg: 'blur=' + r.blurRadius + ' thr=' + r.edgeThreshold + ' pc=' + r.preContrast + ' aspect=' + r.minAspect, counts: counts.join('  ') })
  })
  if (winners.length === 0) {
    console.log('  NONE — no static config hits the DoD on all fixtures. Escalate (alignment post-filter / FFT).')
  } else {
    winners.forEach(function (wn) { console.log('  ' + wn.cfg + '   [' + wn.counts + ']') })
  }
})().catch(function (e) { console.error(e); process.exit(1) })
