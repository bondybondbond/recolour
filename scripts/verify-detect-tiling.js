#!/usr/bin/env node
/*
 * Real-fixture parity verification for detectTiling() (#50, T29 Phase 2d).
 *
 * Runs the engine's detectTiling() against the same fixtures used in the #49 spike and asserts
 * that the verdicts match the spike's GO evidence in scripts/evidence/spike-fft-2/results.txt.
 * This is the "port fidelity" guard from the dev plan: if the N-parameterisation or lag-scaling
 * slipped during the verbatim port, these assertions catch it.
 *
 *   node scripts/verify-detect-tiling.js
 *
 * NOT part of `npm test` — intentionally kept separate because:
 *   - It decodes multi-MB JPEG fixtures (slow, ~10-20s total).
 *   - It requires the jpeg-js memory cap override (WORKFLOW-15) for the 4K/8K eagle negative.
 *     That override is local to this harness and must NEVER propagate to web/ or src/.
 *
 * Pass: all assertions print PASS and exit 0.
 * Fail: the first failing assertion prints FAIL + reason and exits 1.
 */
'use strict'

var path = require('path')
var _Jimp = require('jimp')
var Jimp = _Jimp.default || _Jimp  // CORE-1: CJS vs ESM

// The 4K/8K eagle negative blows jpeg-js's default 512MB memory cap (WORKFLOW-15).
// Override at decode-time only — this harness only, never in production paths.
var jpegjs = require('jpeg-js')
Jimp.decoders['image/jpeg'] = function (data) {
  return jpegjs.decode(data, { maxMemoryUsageInMB: 2048, maxResolutionInMP: 600 })
}

var engine = require('../web/recolour-engine')
var FIX = path.join(__dirname, '..', 'test', 'files')

var PASS = 0, FAIL = 0
function assert (cond, label, detail) {
  if (cond) { console.log('PASS  ' + label); PASS++ }
  else { console.error('FAIL  ' + label + (detail ? '\n      ' + detail : '')); FAIL++ }
}

// Decode a fixture to the {data,width,height} shape detectTiling() expects.
// Jimp's RGBA bitmap can be used directly (detectTiling reads .data as Uint8[RGBA]).
function decode (file) {
  return Jimp.read(path.join(FIX, file)).then(function (im) {
    return { data: im.bitmap.data, width: im.bitmap.width, height: im.bitmap.height }
  })
}

;(async function () {
  console.log('verify-detect-tiling.js — parity check against spike #49 evidence')
  console.log('engine version: ' + (require('../package.json').version || 'unknown'))
  console.log()

  // ---- TILING POSITIVES (must return tiling:true, combCount >= COMB_MIN=4) -------------------

  // CTRL+ TAYLOR GALE bold tiling — spike: TILING 5-peak comb, fund ~35px (all 4 configs pass).
  var img = await decode('repeated-tile-template.jpg')
  var r = engine.detectTiling(img)
  assert(r.tiling === true, 'CTRL+ TAYLOR GALE: tiling:true',
    'got tiling:' + r.tiling + ' combCount:' + r.combCount + ' period:' + r.period + 'px')
  assert(r.combCount >= 4, 'CTRL+ TAYLOR GALE: combCount >= 4', 'got ' + r.combCount)

  // CTRL+ "Delete me" dense tiling — spike: TILING, fund ~11px.
  img = await decode('delete me.png')
  r = engine.detectTiling(img)
  assert(r.tiling === true, 'CTRL+ "Delete me": tiling:true',
    'got tiling:' + r.tiling + ' combCount:' + r.combCount + ' period:' + r.period + 'px')
  assert(r.combCount >= 4, 'CTRL+ "Delete me": combCount >= 4', 'got ' + r.combCount)

  // TARGET WhatsApp .19 — spike: TILING 5-peak comb, fund ~67px (hp+lcn+log config).
  img = await decode('WhatsApp Image 2026-06-23 at 19.34.19.jpeg')
  r = engine.detectTiling(img)
  assert(r.tiling === true, 'TARGET WhatsApp .19: tiling:true',
    'got tiling:' + r.tiling + ' combCount:' + r.combCount + ' period:' + r.period + 'px')
  assert(r.combCount >= 4, 'TARGET WhatsApp .19: combCount >= 4', 'got ' + r.combCount)
  // Period may differ from spike's ~67px: multi-RBIG sweep picks the RBIG that maximises combCount,
  // which can surface a different sub-period (e.g. 40px instead of 67px). tiling:true is the contract.
  assert(r.period > 10, 'TARGET WhatsApp .19: period above JPEG artifact floor',
    'got period:' + r.period + 'px')

  // TARGET WhatsApp .50 — spike: TILING 10-peak comb, fund ~66px.
  img = await decode('WhatsApp Image 2026-06-23 at 19.34.50.jpeg')
  r = engine.detectTiling(img)
  assert(r.tiling === true, 'TARGET WhatsApp .50: tiling:true',
    'got tiling:' + r.tiling + ' combCount:' + r.combCount + ' period:' + r.period + 'px')
  assert(r.combCount >= 4, 'TARGET WhatsApp .50: combCount >= 4', 'got ' + r.combCount)

  // TARGET kids1 (non-WhatsApp source) — spike: same period/comb as WhatsApp, confirming
  // transport/recompression is NOT the bottleneck (LEARNINGS CORE-16 #49 addendum).
  img = await decode('kids1.jpg')
  r = engine.detectTiling(img)
  assert(r.tiling === true, 'TARGET kids1: tiling:true',
    'got tiling:' + r.tiling + ' combCount:' + r.combCount + ' period:' + r.period + 'px')
  assert(r.combCount >= 4, 'TARGET kids1: combCount >= 4', 'got ' + r.combCount)

  // TARGET kids2 (non-WhatsApp source).
  img = await decode('kids2.jpg')
  r = engine.detectTiling(img)
  assert(r.tiling === true, 'TARGET kids2: tiling:true',
    'got tiling:' + r.tiling + ' combCount:' + r.combCount + ' period:' + r.period + 'px')
  assert(r.combCount >= 4, 'TARGET kids2: combCount >= 4', 'got ' + r.combCount)

  // ---- TILING NEGATIVES (must return tiling:false) ------------------------------------------

  // CTRL- flying-eagle photo (no watermark) — spike: NONE or MARGINAL under most configs;
  // under hp+lcn+log it reaches MARGINAL (~7.4x, NO clean >=4 comb). The critical discriminator:
  // tiling:false because combCount < COMB_MIN=4 even at the inflated ratio (CORE-16 gate rule).
  img = await decode('high_resolution_flying_eagle_4k_8k_hd.jpg')
  r = engine.detectTiling(img)
  assert(r.tiling === false, 'CTRL- eagle (no watermark): tiling:false',
    'got tiling:' + r.tiling + ' combCount:' + r.combCount + ' topRatio:' + r.topRatio.toFixed(1) + 'x')

  // CTRL- single copyright watermark on photo — spike: NONE (no tiling, single mark).
  img = await decode('copyright-watermark.png')
  r = engine.detectTiling(img)
  assert(r.tiling === false, 'CTRL- copyright-watermark.png (single mark): tiling:false',
    'got tiling:' + r.tiling + ' combCount:' + r.combCount)

  // ---- #51 COMB_MIN=5 MARGIN REPORT ----------------------------------------------------------
  // #51 asks whether COMB_MIN=5 is overfit. We decode JPEG-compressed harder fixtures (generated by
  // scripts/generate-tiling-fixtures.js — real DCT noise, the lever clean synthetics lack) plus the
  // existing real positives, and classify each combCount against the #51 bands:
  //   >= 6  comfortable margin
  //   == 5  AT GATE (note a confidence-band UX for the GUI slice)
  //   == 4  BELOW GATE -> false negative -> COMB_MIN product decision required before the GUI slice
  // This section is a REPORT, not a parity assertion: it prints the margin verdict and flags the
  // STOP band, but does not fail the port-fidelity check above (that is a separate concern).
  console.log()
  console.log('---- #51 COMB_MIN=' + 5 + ' margin report (JPEG-compressed harder fixtures) ----')
  var marginRows = [
    // Generated harder fixtures (compression / resolution / angle axes).
    { file: 'gen-diagonal-stripes.jpg', label: 'GEN diagonal stripes q60' },
    { file: 'gen-heavy-compression-partial.jpg', label: 'GEN partial+heavy q18' },
    { file: 'gen-lowres-fewrepeats.jpg', label: 'GEN low-res 256px q50' },
    // Existing real positives, for baseline margin context.
    { file: 'repeated-tile-template.jpg', label: 'REAL TAYLOR GALE' },
    { file: 'delete me.png', label: 'REAL Delete me' },
    { file: 'WhatsApp Image 2026-06-23 at 19.34.19.jpeg', label: 'REAL WhatsApp .19' },
    { file: 'WhatsApp Image 2026-06-23 at 19.34.50.jpeg', label: 'REAL WhatsApp .50' }
  ]
  var atGate = 0, belowGate = 0
  for (var mi = 0; mi < marginRows.length; mi++) {
    var row = marginRows[mi]
    var mImg = await decode(row.file)
    var mr = engine.detectTiling(mImg)
    var band = mr.combCount >= 6 ? 'comfortable' : (mr.combCount === 5 ? 'AT GATE' : (mr.combCount === 4 ? 'BELOW GATE (false negative)' : 'well below'))
    if (mr.combCount === 5) atGate++
    if (mr.combCount <= 4) belowGate++
    console.log('  ' + (mr.tiling ? 'TILING ' : 'none   ') +
      'combCount=' + mr.combCount + ' period=' + mr.period + 'px  [' + band + ']  ' + row.label)
  }
  console.log()
  if (belowGate > 0) {
    console.log('#51 VERDICT: STOP-BAND — ' + belowGate + ' harder fixture(s) fall BELOW the gate ' +
      '(combCount <= 4 => tiling:false). COMB_MIN=5 is thin: a low-res + compressed tiling is a false ' +
      'negative. Product decision (keep 5 + document, or lower to 4) required before the Phase 3 GUI ' +
      'slice. Engine-core (propagateMask) is decoupled from the gate, so it can proceed under a logged ' +
      'assumption — see the #51 comment.')
  } else if (atGate > 0) {
    console.log('#51 VERDICT: AT-GATE — ' + atGate + ' harder fixture(s) sit exactly at combCount=5. ' +
      'Margin is thin but no false negatives; a confidence-band UX is advisable in the GUI slice.')
  } else {
    console.log('#51 VERDICT: COMFORTABLE — all harder fixtures combCount >= 6.')
  }

  // ---- #46 tileBasis guard on a JPEG-compressed fixture --------------------------------------
  // The unit tests exercise tileBasis on CLEAN synthetics; only a real JPEG carries the DCT noise that
  // can surface a spurious 2nd basis vector (artefact-peak risk, engine B1 caveat). Assert the diagonal
  // fixture yields a plausible PRIMARY basis (magnitude ~ period) and, if a 2nd vector exists, that it
  // is genuinely non-collinear with the primary. (Lenient by design — a missing 2nd vector is valid
  // 1-D tiling, not a failure.)
  console.log()
  console.log('---- #46 tileBasis guard (JPEG diagonal fixture) ----')
  var dImg = await decode('gen-diagonal-stripes.jpg')
  var dr = engine.detectTiling(dImg)
  assert(Array.isArray(dr.tileBasis) && dr.tileBasis.length >= 1,
    'GEN diagonal: tileBasis surfaced', 'got ' + JSON.stringify(dr.tileBasis))
  if (dr.tileBasis.length >= 1) {
    var pmag = Math.hypot(dr.tileBasis[0].x, dr.tileBasis[0].y)
    assert(Math.abs(pmag - dr.period) < 2,
      'GEN diagonal: |tileBasis[0]| ~= period', '|basis0|=' + pmag.toFixed(1) + ' period=' + dr.period)
  }
  if (dr.tileBasis.length >= 2) {
    var b0 = dr.tileBasis[0], b1 = dr.tileBasis[1]
    var m0 = Math.hypot(b0.x, b0.y) || 1, m1 = Math.hypot(b1.x, b1.y) || 1
    var col = Math.abs((b0.x * b1.x + b0.y * b1.y) / (m0 * m1))
    assert(col < 0.5, 'GEN diagonal: 2nd basis vector is non-collinear (cos<0.5)', 'cos=' + col.toFixed(2))
  } else {
    console.log('  note: diagonal fixture resolved as 1-D tiling (single basis vector) — valid.')
  }

  // ---- SUMMARY -------------------------------------------------------------------------------
  console.log()
  console.log('Results: ' + PASS + ' PASS, ' + FAIL + ' FAIL (total ' + (PASS + FAIL) + ')')
  if (FAIL > 0) {
    console.error('PARITY CHECK FAILED — the port does not match spike #49 verdicts.')
    process.exit(1)
  }
  console.log('All assertions pass — detectTiling() port matches the #49 spike evidence.')
})().catch(function (e) { console.error(e); process.exit(1) })
