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

  // ---- SUMMARY -------------------------------------------------------------------------------
  console.log()
  console.log('Results: ' + PASS + ' PASS, ' + FAIL + ' FAIL (total ' + (PASS + FAIL) + ')')
  if (FAIL > 0) {
    console.error('PARITY CHECK FAILED — the port does not match spike #49 verdicts.')
    process.exit(1)
  }
  console.log('All assertions pass — detectTiling() port matches the #49 spike evidence.')
})().catch(function (e) { console.error(e); process.exit(1) })
