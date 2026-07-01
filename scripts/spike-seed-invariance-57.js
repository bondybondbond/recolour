#!/usr/bin/env node
/*
 * SPIKE (throwaway) — in-box seed-footprint position-invariance for tile-fill (#57).
 *
 *   node scripts/spike-seed-invariance-57.js
 *
 * WHY THIS SPIKE EXISTS
 * ---------------------
 * runTile() (web/app.js) seeds propagateMask from detectWatermark(...).mask INSIDE the user's box.
 * #58 made the lattice BASIS position-invariant, but the tile-fill confirm card still reports a
 * DIFFERENT instance count depending on which instance the user boxes (CORE-23 / #58 evidence: the
 * SAME "TAYLOR" word boxed at two grid rows gave 18 vs 15 instances). Root cause (confirmed from
 * code, recolour-engine.js:1574): propagateMask counts a node only when the FULL translated seed
 * bbox overlaps the frame, so the counted node set is a function of (a) the seed bbox width/height
 * (varies with box position because detectWatermark's edge shape is content/box-boundary dependent)
 * and (b) the seed's absolute phase.
 *
 * This spike BUILDS NOTHING in web/ or src/. STEP 1 ONLY: reproduce + quantify the variance and run
 * the pre-flight lattice-origin invariance check, mirroring runTile() FAITHFULLY (real detectWatermark
 * seed — NOT the filled box the #58 spike used, since the seed footprint IS the variable under test).
 *
 * PRE-FLIGHT STOP CONDITION (plan devil's-advocate guard): phase canonicalisation can only fix the
 * count if the lattice BASIS itself is already position-invariant across the same-word seeds. If the
 * basis jitters, the fix surface expands into detectTextTiling (near #58 scope) and we RE-PLAN rather
 * than shipping a propagate-side fix that cannot suffice. detectTextTiling exposes no explicit origin;
 * the effective phase propagateMask consumes is the seed mask's absolute bbox — logged as latticePhase.
 *
 * Not part of `npm test`. Durable evidence -> scripts/evidence/spike-seed-57/results.txt.
 */
'use strict'

var fs = require('fs')
var path = require('path')
var _Jimp = require('jimp')
var Jimp = _Jimp.default || _Jimp // CORE-1: CJS vs ESM
var Engine = require('../web/recolour-engine.js') // real shipped engine — reproduce the bug faithfully

var FIX = path.join(__dirname, '..', 'test', 'files')
var OUT = path.join(__dirname, 'evidence', 'spike-seed-57')
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

// GUI-identical detection profile (web/app.js:1005 DETECT_PROFILE). runTile() seeds from THIS exact
// profile; the baseline must use the same to reproduce what the user actually sees.
var DETECT_PROFILE = { edgeThreshold: 150, preContrast: false }

// ---- tee console.log into results.txt ---------------------------------------------------------
var LOG = []
var _log = console.log
console.log = function () { var s = Array.prototype.slice.call(arguments).join(' '); LOG.push(s); _log(s) }
function pad (s, n) { s = String(s); while (s.length < n) s += ' '; return s }

function loadImageData (file) {
  return Jimp.read(path.join(FIX, file)).then(function (im) {
    return { data: im.bitmap.data, width: im.bitmap.width, height: im.bitmap.height }
  })
}

// Seed mask bbox + centroid + pixel count from a detectWatermark mask.
function maskStats (mask, W) {
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, n = 0, sx = 0, sy = 0
  for (var p = 0; p < mask.length; p++) {
    if (!mask[p]) continue
    var x = p % W, y = (p / W) | 0
    n++; sx += x; sy += y
    if (x < minx) minx = x
    if (x > maxx) maxx = x
    if (y < miny) miny = y
    if (y > maxy) maxy = y
  }
  if (!n) return { empty: true, n: 0 }
  return {
    empty: false, n: n,
    minx: minx, miny: miny, maxx: maxx, maxy: maxy,
    w: maxx - minx + 1, h: maxy - miny + 1,
    cx: sx / n, cy: sy / n
  }
}

// canonicalAnchor: reduce the seed-bbox origin (minx,miny) modulo the basis lattice. If phase were
// the only variance driver, a correct propagate-side fix would make the counted node set depend on
// THIS residue + frame — so logging it makes phase drift obvious by eye, independent of counts.
function canonicalAnchor (minx, miny, basis) {
  if (!basis || !basis.length) return { x: minx, y: miny, note: 'no-basis' }
  var v0 = basis[0], v1 = basis[1] || null
  if (v1) {
    var det = v0.x * v1.y - v0.y * v1.x
    if (Math.abs(det) < 1e-9) v1 = null
    else {
      var a = (minx * v1.y - miny * v1.x) / det
      var b = (-minx * v0.y + miny * v0.x) / det
      var fa = a - Math.floor(a), fb = b - Math.floor(b)
      return { x: fa * v0.x + fb * v1.x, y: fa * v0.y + fb * v1.y, note: '2D' }
    }
  }
  var t = (minx * v0.x + miny * v0.y) / (v0.x * v0.x + v0.y * v0.y)
  var ft = t - Math.floor(t)
  return { x: ft * v0.x, y: ft * v0.y, note: '1D' }
}

function basisStr (basis) {
  if (!basis || !basis.length) return '-'
  return basis.map(function (v) { return '(' + v.x + ',' + v.y + ')' }).join(' ')
}
function basisSig (basis) {
  if (!basis || !basis.length) return 'none'
  return basis.map(function (v) { return v.x + ',' + v.y }).sort().join(' | ')
}

// Faithful mirror of runTile() (web/app.js:1112-1150): real detectWatermark seed -> stripe/text basis
// -> propagateMask. canvas.width/height == img.width/height (GUI backing store is image-native).
function runTileMirror (img, region) {
  var W = img.width, H = img.height
  var seed = Engine.detectWatermark(img, DETECT_PROFILE, region).mask
  var t = Engine.detectTiling(img, { region: region })
  var basis = t.tileBasis
  var textMode = false, textConfidence = 0, textTiling = false
  if (t.combCount < t.combMin) {
    var tt = Engine.detectTextTiling(img, region)
    textTiling = tt.tiling
    if (tt.tiling) { basis = tt.tileBasis; textMode = true; textConfidence = tt.confidence }
  }
  var prop = Engine.propagateMask(seed, W, H, basis)
  return {
    seed: seed, seedStats: maskStats(seed, W),
    combCount: t.combCount, combMin: t.combMin, textMode: textMode, textTiling: textTiling,
    textConfidence: textConfidence, basis: basis, prop: prop
  }
}

function printRow (label, region, r) {
  var s = r.seedStats
  var anch = s.empty ? { x: 0, y: 0, note: 'empty-seed' } : canonicalAnchor(s.minx, s.miny, r.basis)
  console.log(
    pad(label, 16) +
    ' seedRect=(' + region.x + ',' + region.y + ',' + region.width + 'x' + region.height + ')' +
    (s.empty
      ? ' seedBbox=<EMPTY>'
      : ' seedBbox=' + s.w + 'x' + s.h + '@(' + s.minx + ',' + s.miny + ')' +
        ' seedCentroid=(' + s.cx.toFixed(0) + ',' + s.cy.toFixed(0) + ')' + ' seedPx=' + s.n) +
    '\n' + pad('', 16) +
    ' path=' + (r.textMode ? 'TEXT(conf=' + r.textConfidence.toFixed(2) + ')' : 'STRIPE') +
    ' combCount=' + r.combCount + '/' + r.combMin +
    ' basis=' + basisStr(r.basis) +
    ' latticePhase=(' + (s.empty ? '-' : s.minx + ',' + s.miny) + ')' +
    ' canonAnchor=(' + anch.x.toFixed(1) + ',' + anch.y.toFixed(1) + ')[' + anch.note + ']' +
    '\n' + pad('', 16) +
    ' => instances=' + r.prop.instances + ' rows=' + r.prop.rows + ' cols=' + r.prop.cols +
    (r.prop.subharmonicWarning ? ' SUBHARM' : '')
  )
}

function spread (arr) { var mn = Math.min.apply(null, arr), mx = Math.max.apply(null, arr); return { min: mn, max: mx, d: mx - mn } }

// -------------------------------------------------------------------------------------------------
// STEP 2 candidate: CANONICAL-PHASE + BASIS-DERIVED FOOTPRINT gate (the v2 fix under test).
// -------------------------------------------------------------------------------------------------
// The DISPROVEN naive fix (kept as a reference row): gate on the seed CENTROID (a single point). It
// hits spread=0 but collapses to the WORST seed's count (10 not 18) — a recall loss — because a point
// in-frame is stricter than bbox-overlap and drops partial-edge instances. Recorded, not shipped.
function simulateCentroidGate (ax, ay, basis, W, H) {
  return simulateCanonicalGate(ax, ay, basis, W, H, 0) // footprintFrac 0 == centroid point gate
}

// The v2 fix: count a node if its position lies in the frame EXPANDED by `footprintFrac` of the basis
// half-pitch on each axis. This is basis-derived (seed-footprint-independent → kills driver 2) and, at
// frac≈0.5 (Voronoi cell overlaps frame), keeps the partial-edge instances (→ ~18, not 10). `ax,ay` is
// the CANONICAL origin (bbox-origin reduced modulo the basis, computed by canonicalOrigin()), so the
// node set is a function of (basis, frame, canonical phase) only — invariant to which instance boxed.
function simulateCanonicalGate (ax, ay, basis, W, H, footprintFrac) {
  var vecs = []
  if (basis) {
    for (var bi = 0; bi < basis.length; bi++) {
      var mag = Math.hypot(basis[bi].x, basis[bi].y)
      if (mag > 0) vecs.push({ x: basis[bi].x, y: basis[bi].y, mag: mag })
    }
  }
  if (!vecs.length) return { instances: 1, rows: 1, cols: 1 }
  var v0 = vecs[0], v1 = vecs[1] || null
  // Per-axis half-extent of the lattice cell (mirrors an axis-aligned pitch; general for any basis).
  var hx = footprintFrac * 0.5 * (Math.abs(v0.x) + (v1 ? Math.abs(v1.x) : 0))
  var hy = footprintFrac * 0.5 * (Math.abs(v0.y) + (v1 ? Math.abs(v1.y) : 0))
  var diag = W + H
  var iMax = Math.ceil(diag / v0.mag) + 2
  var jMax = v1 ? Math.ceil(diag / v1.mag) + 2 : 0
  var iSeen = new Uint8Array(2 * iMax + 1), jSeen = new Uint8Array(2 * jMax + 1)
  var instances = 0, rows = 0, cols = 0
  for (var i = -iMax; i <= iMax; i++) {
    for (var j = -jMax; j <= jMax; j++) {
      var nx = ax + i * v0.x + (v1 ? j * v1.x : 0)
      var ny = ay + i * v0.y + (v1 ? j * v1.y : 0)
      if (nx < -hx || nx >= W + hx || ny < -hy || ny >= H + hy) continue // expanded-frame node gate
      instances++
      if (!iSeen[i + iMax]) { iSeen[i + iMax] = 1; cols++ }
      if (!jSeen[j + jMax]) { jSeen[j + jMax] = 1; rows++ }
    }
  }
  return { instances: instances, rows: rows, cols: cols }
}

// Canonical origin: reduce the seed bbox origin (minx,miny) into the fundamental cell of the basis
// (frac of each basis coordinate). Congruent seed instances -> identical residue; manual box jitter ->
// a sub-cell offset the expanded-frame gate absorbs. Do NOT use the centroid (bbox-width polluted).
function canonicalOrigin (minx, miny, basis) {
  if (!basis || !basis.length) return { x: minx, y: miny }
  var v0 = basis[0], v1 = basis[1] || null
  if (v1) {
    var det = v0.x * v1.y - v0.y * v1.x
    if (Math.abs(det) > 1e-9) {
      var a = (minx * v1.y - miny * v1.x) / det
      var b = (-minx * v0.y + miny * v0.x) / det
      var fa = a - Math.floor(a), fb = b - Math.floor(b)
      return { x: fa * v0.x + fb * v1.x, y: fa * v0.y + fb * v1.y }
    }
  }
  var t = (minx * v0.x + miny * v0.y) / (v0.x * v0.x + v0.y * v0.y)
  var ft = t - Math.floor(t)
  return { x: ft * v0.x, y: ft * v0.y }
}

// "True" visible instance count reference: lattice nodes whose CENTRE (Voronoi cell) lands in-frame,
// i.e. the canonical gate at footprintFrac=0.5 anchored at the seed's own node. Used only as the
// <= trueCount over-stamp ceiling in the go/no-go, independent of the fix's own origin choice.
function trueNodeCount (cx, cy, basis, W, H) {
  return simulateCanonicalGate(cx, cy, basis, W, H, 0.5).instances
}

loadImageData('repeated-tile-template.jpg').then(function (img) {
  console.log('SPIKE #57 — in-box seed-footprint position-invariance (STEP 1 baseline)')
  console.log('fixture repeated-tile-template.jpg ' + img.width + 'x' + img.height)
  console.log('DETECT_PROFILE = ' + JSON.stringify(DETECT_PROFILE) + '  (GUI-identical)\n')

  // The SAME "TAYLOR" word boxed at 3 valid grid rows (exact seed rects from the #58 spike cohort,
  // scripts/spike-lattice-fit-58.js:694-696). Same glyph, same width box — only the ROW changes.
  var seeds = [
    { label: 'TAYLOR row1', x: 330, y: 32, width: 150, height: 46 },
    { label: 'TAYLOR row3', x: 330, y: 268, width: 150, height: 46 },
    { label: 'TAYLOR row5', x: 330, y: 490, width: 150, height: 46 }
  ]

  console.log('=== BASELINE (shipped engine, no fix) — same TAYLOR word at 3 positions ===\n')
  var recs = seeds.map(function (s) {
    var region = { x: s.x, y: s.y, width: s.width, height: s.height }
    var r = runTileMirror(img, region)
    printRow(s.label, region, r)
    console.log('')
    return { seed: s, r: r }
  })

  // ---- pre-flight: is the BASIS (lattice) already position-invariant? -------------------------
  var sigs = {}
  recs.forEach(function (rc) { var k = basisSig(rc.r.basis); sigs[k] = (sigs[k] || 0) + 1 })
  var distinctBases = Object.keys(sigs).length
  var basisInvariant = distinctBases === 1
  console.log('--- PRE-FLIGHT: lattice-basis position-invariance (the #58 property) ---')
  console.log('  distinct bases across 3 positions = ' + distinctBases +
    '   ' + Object.keys(sigs).map(function (k) { return '[' + sigs[k] + 'x](' + k + ')' }).join('  '))
  console.log('  basis invariant: ' + (basisInvariant ? 'YES — propagate-side phase fix is the correct surface'
    : 'NO — STOP: fix surface expands into detectTextTiling (#58 scope), RE-PLAN'))

  // ---- quantify the count variance (the CORE-23 harm) -----------------------------------------
  var inst = recs.map(function (rc) { return rc.r.prop.instances })
  var rows = recs.map(function (rc) { return rc.r.prop.rows })
  var cols = recs.map(function (rc) { return rc.r.prop.cols })
  var bbw = recs.map(function (rc) { return rc.r.seedStats.empty ? 0 : rc.r.seedStats.w })
  var bbh = recs.map(function (rc) { return rc.r.seedStats.empty ? 0 : rc.r.seedStats.h })
  var si = spread(inst), sr = spread(rows), sc = spread(cols), sw = spread(bbw), sh = spread(bbh)
  console.log('\n--- VARIANCE (baseline; goal after fix = spread 0 on all three of instances/rows/cols) ---')
  console.log('  seedBbox W : ' + JSON.stringify(bbw) + '  spread=' + sw.d + 'px')
  console.log('  seedBbox H : ' + JSON.stringify(bbh) + '  spread=' + sh.d + 'px')
  console.log('  instances  : ' + JSON.stringify(inst) + '  spread=' + si.d)
  console.log('  rows       : ' + JSON.stringify(rows) + '  spread=' + sr.d)
  console.log('  cols       : ' + JSON.stringify(cols) + '  spread=' + sc.d)
  console.log('\n  CORE-23 reproduced: ' +
    ((si.d > 1 || sr.d > 1 || sc.d > 1) ? 'YES — count varies with box position (harm confirmed)'
      : 'NO — counts already stable (re-check seed rects / fixture)'))

  var baselineMax = si.max
  // trueCount ceiling (over-stamp guard): Voronoi-cell-in-frame count anchored at each seed's OWN node.
  var trueCounts = recs.map(function (rc) {
    var s = rc.r.seedStats
    return s.empty ? 0 : trueNodeCount(s.minx, s.miny, rc.r.basis, img.width, img.height)
  })
  var trueCeil = Math.max.apply(null, trueCounts)
  console.log('  trueCount reference (Voronoi cell-in-frame, per seed): ' + JSON.stringify(trueCounts) +
    '  -> ceiling=' + trueCeil)

  // ---- STEP 2: the v2 fix under test — CANONICAL gate (measurement only, NO engine change yet) --
  // Reference row: the DISPROVEN centroid-point gate (footprintFrac 0). Then sweep the footprint knob
  // for the basis-derived expanded-frame gate; the winner is the SMALLEST frac that is invariant
  // (spread<=1) AND >= baselineMax (no recall loss) AND <= trueCeil (no over-stamp).
  console.log('\n=== STEP 2: CANONICAL-phase + basis-footprint gate — PREDICTION (no engine change) ===')
  console.log('  baselineMax=' + baselineMax + '  trueCeil=' + trueCeil + '  (target: invariant, in [baselineMax, trueCeil])\n')

  function evalGate (label, fn) {
    var out = recs.map(function (rc) {
      var s = rc.r.seedStats
      if (s.empty) return { instances: 0, rows: 0, cols: 0 }
      return fn(rc, s)
    })
    var gi = out.map(function (o) { return o.instances })
    var gr = out.map(function (o) { return o.rows })
    var gc = out.map(function (o) { return o.cols })
    var gsi = spread(gi), gsr = spread(gr), gsc = spread(gc)
    var invariant = gsi.d <= 1 && gsr.d <= 1 && gsc.d <= 1
    var noRecallLoss = gsi.min >= baselineMax
    var noOverStamp = gsi.max <= trueCeil
    console.log('  ' + pad(label, 26) + ' instances=' + JSON.stringify(gi) + ' rows=' + JSON.stringify(gr) +
      ' cols=' + JSON.stringify(gc))
    console.log('  ' + pad('', 26) + ' spread(i/r/c)=' + gsi.d + '/' + gsr.d + '/' + gsc.d +
      '  invariant=' + invariant + ' noRecallLoss=' + noRecallLoss + ' noOverStamp=' + noOverStamp +
      '  => ' + ((invariant && noRecallLoss && noOverStamp) ? 'PASS' : 'FAIL'))
    return { invariant: invariant, noRecallLoss: noRecallLoss, noOverStamp: noOverStamp, min: gsi.min, max: gsi.max }
  }

  // Reference: disproven centroid-point gate.
  evalGate('centroid-point (disproven)', function (rc, s) {
    return simulateCentroidGate(s.cx, s.cy, rc.r.basis, img.width, img.height)
  })
  console.log('')
  // Footprint-knob sweep on the canonical (bbox-origin mod basis) gate.
  var FRACS = [0.25, 0.5, 0.75, 1.0]
  var winner = null
  FRACS.forEach(function (frac) {
    var res = evalGate('canonical frac=' + frac.toFixed(2), function (rc, s) {
      var o0 = canonicalOrigin(s.minx, s.miny, rc.r.basis)
      return simulateCanonicalGate(o0.x, o0.y, rc.r.basis, img.width, img.height, frac)
    })
    if (!winner && res.invariant && res.noRecallLoss && res.noOverStamp) winner = { frac: frac, res: res }
  })

  // Port-equivalence check: the ENGINE loop anchors at the seed's OWN bbox min (minx,miny), NOT the
  // reduced o0. Both generate the same absolute lattice (congruent mod basis), so the expanded-frame
  // point gate must yield the SAME in-frame node set. Confirm here so the engine port is just a gate
  // swap (no origin-reduction needed in propagateMask).
  console.log('\n  port-equivalence — seed-anchor (minx,miny) at frac=0.50 (what the engine will do):')
  evalGate('seed-anchor frac=0.50', function (rc, s) {
    return simulateCanonicalGate(s.minx, s.miny, rc.r.basis, img.width, img.height, 0.5)
  })

  // Integration check: run the REAL patched engine propagateMask with {frameCanonical:true} on each
  // seed's actual detectWatermark mask. This proves the shipped port matches the prediction above.
  console.log('\n  integration — REAL Engine.propagateMask(seed, W, H, basis, {frameCanonical:true}):')
  var engInst = [], engRows = [], engCols = []
  recs.forEach(function (rc) {
    var p = Engine.propagateMask(rc.r.seed, img.width, img.height, rc.r.basis, { frameCanonical: true })
    engInst.push(p.instances); engRows.push(p.rows); engCols.push(p.cols)
    console.log('  ' + pad(rc.seed.label, 16) + ' instances=' + p.instances + ' rows=' + p.rows + ' cols=' + p.cols +
      (p.subharmonicWarning ? ' SUBHARM' : ''))
  })
  var ei = spread(engInst), er = spread(engRows), ec = spread(engCols)
  var engInvariant = ei.d <= 1 && er.d <= 1 && ec.d <= 1 && ei.min >= baselineMax && ei.max <= trueCeil
  console.log('  engine spread(i/r/c)=' + ei.d + '/' + er.d + '/' + ec.d +
    '  in[baselineMax,trueCeil]=' + (ei.min >= baselineMax && ei.max <= trueCeil) + '  => ' +
    (engInvariant ? 'PASS (matches prediction)' : 'FAIL'))

  // ---- HARD go/no-go (plan: rung-1 is a measured gate, not a formality) ------------------------
  console.log('\n================= RUNG-1 GO / NO-GO =================')
  if (winner) {
    console.log('GO — canonical gate at footprintFrac=' + winner.frac.toFixed(2) +
      ' is invariant (spread<=1), >= baselineMax(' + baselineMax + '), <= trueCeil(' + trueCeil + ').')
    console.log('Port this footprint fraction to propagateMask under opts.frameCanonical.')
  } else {
    console.log('NO-GO — no footprint fraction met all three of {invariant, no recall loss, no over-stamp}.')
    console.log('[TRAP]: rung-1 (bbox-origin-mod-basis phase) is insufficient. STOP — do NOT tune blindly.')
    console.log('Escalate to rung-2 (snap origin to nearest detected node; touches detectTextTiling) after checkpoint.')
  }
  console.log('====================================================')

  fs.writeFileSync(path.join(OUT, 'results.txt'), LOG.join('\n') + '\n')
  _log('\nwrote ' + path.relative(process.cwd(), path.join(OUT, 'results.txt')))
}).catch(function (e) { console.error(e); process.exit(1) })
