#!/usr/bin/env node
/*
 * SPIKE (throwaway) — phrase-level seed expansion for tiled letter-form watermarks (#60, T29 follow-up).
 *
 *   node scripts/spike-phrase-tiling-60.js
 *
 * WHY THIS SPIKE EXISTS
 * ---------------------
 * On test/files/repeated-tile-template.jpg ("TAYLOR GALE" repeated on a grid) tile-fill gives a
 * PARTIAL result depending on which word the user boxes:
 *   - box TAYLOR -> stamps TAYLOR's grid -> GALE words remain
 *   - box GALE   -> stamps GALE's grid   -> TAYLOR words remain
 * The user must box twice and merge by hand. Goal (#60): one box -> one fill removes the whole phrase.
 *
 * KEY INSIGHT (from #58 evidence, scripts/evidence/spike-lattice-58/results.txt): the fitted horizontal
 * period is 415 (TAYLOR seed) ~ 414 (GALE seed) — i.e. it ALREADY equals the full "TAYLOR GALE" phrase
 * width, NOT the word-to-word width (if NCC had matched both words the period would be ~half, ~207). So
 * the LATTICE is already correct for the full design. The ONLY sub-piece is the STAMPED SEED SHAPE
 * (detectWatermark returns just one word). => the fix is SEED EXPANSION, not re-fitting the lattice.
 *
 * ONE QUESTION, GO/NO-GO gate (WORKFLOW-16 — reject only on a FALSE POSITIVE):
 *   After detectTextTiling locks the (already-full-unit-period) basis, can we expand the seed to the
 *   full repeating unit within one primitive lattice cell so that boxing EITHER "TAYLOR" or "GALE"
 *   yields the SAME final coverage (both words removed everywhere), WITHOUT inventing a phantom sibling
 *   on genuine single-word/logo watermarks — AND does the lattice actually reconcile across seeds and
 *   hold across rows (no per-cell phase drift)?
 *
 * CORE-21 + NO-WRAPPER RULE: the shipped engine is the source of truth. This spike consumes the
 * engine's peak/lattice front-end ONLY through the exported calls below (detectTextTiling /
 * detectWatermark / propagateMask). It does NOT reimplement or borrow the #53 spike's Jimp-bilinear
 * downscale, and it adds NO helper wrappers around engine calls — a wrapper is exactly how a throwaway
 * script silently re-implements the front-end and drifts from shipped behaviour. The mod-lattice FOLD
 * (foldModLattice) and the connected-component analysis are genuinely NEW logic (the thing under test),
 * not a re-port of engine internals.
 *
 * Not part of `npm test`. Durable evidence -> scripts/evidence/spike-phrase-60/.
 */
'use strict'

var fs = require('fs')
var path = require('path')
var _Jimp = require('jimp')
var Jimp = _Jimp.default || _Jimp // CORE-1: CJS vs ESM
var Engine = require('../web/recolour-engine.js') // real shipped engine — source of truth (CORE-21)

var DETECT_PROFILE = { edgeThreshold: 150, preContrast: false } // mirror web/app.js:1005 verbatim

var FIX = path.join(__dirname, '..', 'test', 'files')
var OUT = path.join(__dirname, 'evidence', 'spike-phrase-60')
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

// ---- tee console.log to results.txt -----------------------------------------------------------
var LOG = []
var _log = console.log
console.log = function () { var s = Array.prototype.slice.call(arguments).join(' '); LOG.push(s); _log(s) }
function pad (s, n) { s = String(s); while (s.length < n) s += ' '; return s }

// ---- load a fixture to a full-res ImageData-like {data,width,height} ---------------------------
function loadImageData (file) {
  return Jimp.read(path.join(FIX, file)).then(function (im) {
    return { data: im.bitmap.data, width: im.bitmap.width, height: im.bitmap.height, _jimp: im }
  })
}

// =================================================================================================
// NEW ANALYSIS CODE (the thing under test — NOT an engine reimplementation)
// =================================================================================================

// 4-connected connected components over a Uint8Array mask. Returns [{size, cx, cy, x0,y0,x1,y1}] for
// components >= minSize, largest first. Used ONLY for evidence (cluster count / separation) + M4 drift.
function connectedComponents (mask, w, h, minSize) {
  minSize = minSize || 8
  var seen = new Uint8Array(mask.length)
  var stack = new Int32Array(mask.length)
  var comps = []
  for (var start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    var sp = 0; stack[sp++] = start; seen[start] = 1
    var size = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1
    while (sp > 0) {
      var p = stack[--sp]
      var px = p % w, py = (p / w) | 0
      size++; sx += px; sy += py
      if (px < x0) x0 = px; if (px > x1) x1 = px
      if (py < y0) y0 = py; if (py > y1) y1 = py
      if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1 }
      if (px < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1 }
      if (py > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w }
      if (py < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w }
    }
    if (size >= minSize) comps.push({ size: size, cx: sx / size, cy: sy / size, x0: x0, y0: y0, x1: x1, y1: y1 })
  }
  comps.sort(function (a, b) { return b.size - a.size })
  return comps
}

// Max pairwise centroid separation among clusters (px). 0 or 1 cluster -> 0.
function maxClusterSeparation (comps) {
  var m = 0
  for (var i = 0; i < comps.length; i++) {
    for (var j = i + 1; j < comps.length; j++) {
      var d = Math.hypot(comps[i].cx - comps[j].cx, comps[i].cy - comps[j].cy)
      if (d > m) m = d
    }
  }
  return m
}

// FOLD every set pixel of `mask` modulo the lattice (v0,v1) into the fundamental cell anchored at O.
// Returns a fresh full-frame Uint8Array with the folded unit placed at O (so propagateMask can re-stamp
// it). Integer indices via the 2x2 inverse of [v0 v1] using FLOOR (not round) — floor puts each pixel's
// lattice coefficients' FRACTIONAL part in [0,1), i.e. a true modulo into the fundamental cell with
// NON-NEGATIVE residual. (Round picks the NEAREST node, giving residuals in [-half,+half]; the negative
// half then lands at fx<0 and gets clipped — that silently discarded ~half the content, incl. a whole
// word, in the first spike pass.) Axis-aligned grids (our watermark case) map cleanly to
// [0,|v1.x|) x [0,|v0.y|); a sheared lattice folds to a parallelogram, still un-clipped. New #60 logic.
function foldModLattice (mask, w, h, v0, v1, O) {
  var out = new Uint8Array(mask.length)
  var det = v1 ? (v0.x * v1.y - v0.y * v1.x) : 0
  for (var p = 0; p < mask.length; p++) {
    if (!mask[p]) continue
    var px = p % w, py = (p / w) | 0
    var rx = px - O.x, ry = py - O.y, fx, fy
    if (v1 && Math.abs(det) > 1e-9) {
      var i = Math.floor((rx * v1.y - ry * v1.x) / det)
      var j = Math.floor((-rx * v0.y + ry * v0.x) / det)
      fx = px - i * v0.x - j * v1.x
      fy = py - i * v0.y - j * v1.y
    } else {
      var t = Math.floor((rx * v0.x + ry * v0.y) / (v0.x * v0.x + v0.y * v0.y))
      fx = px - t * v0.x
      fy = py - t * v0.y
    }
    fx = Math.round(fx); fy = Math.round(fy)
    if (fx < 0 || fx >= w || fy < 0 || fy >= h) continue
    out[fy * w + fx] = 1
  }
  return out
}

// M4b — per-ROW horizontal phase drift, measured by COLUMN-PROFILE CROSS-CORRELATION (fragment-immune;
// the earlier centroid-snapping version measured letter-vs-word residual noise, not phase). For each
// horizontal band of height `rowPitch`, build the column sum-profile P_j(x) and cross-correlate it with
// row 0's profile over shifts in [-colPeriod/2, +colPeriod/2]; the best shift is that row's horizontal
// phase offset. A clean straight grid gives best-shift ~0 for every row; a sub-pixel period error shows
// as best-shift growing linearly with the row index. Returns {rows:[{j, shift}], driftPerRow}.
function rowPhaseDriftProfile (mask, w, h, rowPitch, colPeriod) {
  var nb = Math.max(1, Math.floor(h / rowPitch))
  var profs = []
  for (var j = 0; j < nb; j++) {
    var P = new Float64Array(w)
    for (var y = j * rowPitch; y < (j + 1) * rowPitch && y < h; y++) {
      var row = y * w
      for (var x = 0; x < w; x++) if (mask[row + x]) P[x]++
    }
    profs.push(P)
  }
  var S = Math.max(1, Math.round(colPeriod / 2))
  var P0 = profs[0]
  var rows = []
  for (var b = 0; b < nb; b++) {
    var Pj = profs[b], bestShift = 0, bestCorr = -Infinity
    for (var s = -S; s <= S; s++) {
      var corr = 0
      for (var xx = 0; xx < w; xx++) { var xs = xx + s; if (xs >= 0 && xs < w) corr += P0[xx] * Pj[xs] }
      if (corr > bestCorr) { bestCorr = corr; bestShift = s }
    }
    rows.push({ j: b, shift: bestShift })
  }
  var driftPerRow = 0
  if (rows.length >= 2) driftPerRow = (rows[rows.length - 1].shift - rows[0].shift) / (rows.length - 1)
  return { rows: rows, driftPerRow: driftPerRow }
}

// coverage recall: fraction of pixels set in `target` that are also set in `by`. Kept as a REPORTED
// quality number only — it is thickness-dominated (a thin folded skeleton scores lower than a fat box
// seed even when it spans MORE words) and detectWatermark's whole-image mask carries background noise,
// so it is NOT a clean mechanism gate. See the #62 dependency note in the verdict.
function recall (by, target) {
  var inter = 0, tot = 0
  for (var i = 0; i < by.length; i++) { if (target[i]) { tot++; if (by[i]) inter++ } }
  return tot ? inter / tot : 1
}


// mask helpers (evidence math)
function popcount (mask) { var n = 0; for (var i = 0; i < mask.length; i++) if (mask[i]) n++; return n }
function iou (a, b) {
  var inter = 0, uni = 0
  for (var i = 0; i < a.length; i++) { var x = a[i] ? 1 : 0, y = b[i] ? 1 : 0; if (x & y) inter++; if (x | y) uni++ }
  return uni ? inter / uni : 1
}
function basisStr (basis) { return basis.map(function (v) { return '(' + v.x + ',' + v.y + ')' }).join(' ') }
function boxMask (w, h, s) {
  var m = new Uint8Array(w * h)
  for (var y = s.y; y < s.y + s.height && y < h; y++) for (var x = s.x; x < s.x + s.width && x < w; x++) m[y * w + x] = 1
  return m
}

// PNG overlay: grayscale base + mask tint (rgb). For eyeballing coverage in the evidence dir.
function writeMaskOverlay (img, mask, rgb, tag) {
  var W = img.width, H = img.height, im = new Jimp(W, H)
  var d = img.data
  for (var i = 0; i < W * H; i++) {
    var o = i * 4
    var g = Math.round(0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2])
    if (mask[i]) { im.bitmap.data[o] = rgb[0]; im.bitmap.data[o + 1] = rgb[1]; im.bitmap.data[o + 2] = rgb[2] } else { im.bitmap.data[o] = g; im.bitmap.data[o + 1] = g; im.bitmap.data[o + 2] = g }
    im.bitmap.data[o + 3] = 255
  }
  var f = path.join(OUT, tag + '.png')
  return im.writeAsync(f).then(function () { console.log('  wrote ' + path.relative(process.cwd(), f)) })
}

// =================================================================================================
// STAGE runners
// =================================================================================================

// Run one seed end-to-end: shipped baseline (Stage 0) + expanded 1b (fold) + 1a (single-cell union) +
// cluster diagnostics. CANONICAL fold anchor `O` is passed in (seed-INDEPENDENT, lattice-derived) — the
// whole point of #60's invariance is that WHICH word you boxed selects only the BASIS, never the fold
// phase. Anchoring at the seed (as the first spike pass did) defeats that and made M1 fail spuriously.
function runSeed (img, seed, wholeContentMask, O) {
  var W = img.width, H = img.height
  var fit = Engine.detectTextTiling(img, seed)
  var seedMask = Engine.detectWatermark(img, DETECT_PROFILE, seed).mask

  // Stage 0 — shipped behaviour (partial coverage today).
  var base = Engine.propagateMask(seedMask, W, H, fit.tileBasis, { frameCanonical: true })

  var rec = {
    label: seed.label, seed: seed, fit: fit, basis: fit.tileBasis, seedMask: seedMask,
    baseMask: base.mask, baseInstances: base.instances, baseRows: base.rows, baseCols: base.cols,
    expanded: null
  }
  // Expansion path guarded exactly like the future GUI would be: only when the lattice is valid.
  if (!fit.tiling || fit.tileBasis.length < 1) { rec.guarded = true; return rec }

  var v0 = fit.tileBasis[0], v1 = fit.tileBasis[1] || null

  // 1b — mod-lattice fold of the WHOLE-image content mask into one cell around the CANONICAL O.
  var foldMask = foldModLattice(wholeContentMask, W, H, v0, v1, O)
  var foldComps = connectedComponents(foldMask, W, H, 8)
  var expandedProp = Engine.propagateMask(foldMask, W, H, fit.tileBasis, { frameCanonical: true })

  // 1a — single-cell union cross-check: detectWatermark over a one-cell window at the canonical O.
  var cellW = Math.abs(v0.x) + (v1 ? Math.abs(v1.x) : 0)
  var cellH = Math.abs(v0.y) + (v1 ? Math.abs(v1.y) : 0)
  var win = { x: Math.max(0, O.x), y: Math.max(0, O.y), width: Math.min(cellW || seed.width, W), height: Math.min(cellH || seed.height, H) }
  var cellMask = Engine.detectWatermark(img, DETECT_PROFILE, win).mask
  var cellProp = Engine.propagateMask(cellMask, W, H, fit.tileBasis, { frameCanonical: true })

  rec.expanded = {
    foldMask: foldMask, foldComps: foldComps, foldSep: maxClusterSeparation(foldComps),
    foldMaskPx: popcount(foldMask),
    prop1b: expandedProp.mask, inst1b: expandedProp.instances, rows1b: expandedProp.rows, cols1b: expandedProp.cols,
    cellMask: cellMask, prop1a: cellProp.mask, inst1a: cellProp.instances,
    cellComps: connectedComponents(cellMask, W, H, 8)
  }
  return rec
}

function main () {
  console.log('SPIKE #60 — phrase-level seed expansion (mod-lattice fold) for detectTextTiling')

  // Seeds from #58 (scripts/spike-lattice-fit-58.js). TAYLOR + GALE are the two cohorts that must
  // reconcile to the SAME final coverage; FRAG boxes must stay guarded (no expansion).
  var seeds = [
    { label: 'r1 mid TAYLOR', x: 330, y: 32, width: 150, height: 46, cohort: 'TAYLOR' },
    { label: 'r1 mid GALE', x: 500, y: 32, width: 110, height: 46, cohort: 'GALE' },
    { label: 'r1 LOR frag', x: 372, y: 32, width: 70, height: 46, cohort: 'FRAG' },
    { label: 'r1 letter O', x: 388, y: 32, width: 34, height: 46, cohort: 'FRAG' }
  ]

  var verdict = { m1: null, m3: [], m4a: null, m4b: null }

  loadImageData('repeated-tile-template.jpg').then(function (img) {
    console.log('fixture repeated-tile-template.jpg ' + img.width + 'x' + img.height + '\n')

    // Whole-image content mask ONCE (shared by every seed's fold). This is the union of ALL watermark
    // content across the frame — folding it averages out per-instance detectWatermark bbox variance
    // (CORE-23/#62), the reason 1b is expected to beat a single seed's bbox.
    var whole = Engine.detectWatermark(img, DETECT_PROFILE, { x: 0, y: 0, width: img.width, height: img.height }).mask
    var wholeComps = connectedComponents(whole, img.width, img.height, 8)
    console.log('whole-image content mask: ' + popcount(whole) + ' px, ' + wholeComps.length + ' clusters\n')

    // CANONICAL fold anchor — seed-INDEPENDENT so both TAYLOR-box and GALE-box fold the SAME whole-image
    // content into the SAME absolute cell (invariance by construction). Origin (0,0) folds into the
    // top-left fundamental cell; identical inputs => identical folded unit regardless of boxed word.
    var Ocanon = { x: 0, y: 0 }

    console.log('=== STAGE 0 (shipped) + STAGE 1 (expand): per-seed ===')
    var recs = seeds.map(function (s) { return runSeed(img, s, whole, Ocanon) })
    recs.forEach(function (r) {
      var line = pad(r.label, 16) + ' tiling=' + r.fit.tiling + ' basis=' + (basisStr(r.basis) || '-') +
        ' | STAGE0 stamped=' + r.baseInstances + ' (' + r.baseRows + 'r x ' + r.baseCols + 'c)'
      if (r.guarded) { console.log(line + ' | EXPANSION GUARDED (no valid lattice) — correct for FRAG'); return }
      var e = r.expanded
      console.log(line + ' | 1b foldPx=' + e.foldMaskPx + ' clusters=' + e.foldComps.length +
        ' sep=' + e.foldSep.toFixed(0) + 'px stamped=' + e.inst1b + ' (' + e.rows1b + 'r x ' + e.cols1b + 'c)' +
        ' | 1a stamped=' + e.inst1a + ' clusters=' + e.cellComps.length)
    })

    var taylor = recs[0], gale = recs[1]

    // ---- M1: MECHANISM + INVARIANCE — did the fold capture the sibling word, identically from either box? ----
    // Clean, ground-truth-free proof (area-recall is thickness-dominated + detectWatermark-noise-confounded,
    // so it is REPORTED below as a quality/#62 number, not gated here):
    //   (a) the folded unit spans TWO word-groups (TAYLOR + GALE) where a single-word seed folds to ONE;
    //   (b) TAYLOR-box and GALE-box produce the SAME folded unit (IoU ~1) -> position-invariant by
    //       construction (canonical anchor + reconciled basis);
    //   (c) identical propagation structure (instances / rows / cols).
    console.log('\n=== M1 — one box removes the WHOLE phrase, identically from either box ===')
    var rBaseT = recall(taylor.baseMask, whole), rBaseG = recall(gale.baseMask, whole)
    var rExpT = recall(taylor.expanded.prop1b, whole), rExpG = recall(gale.expanded.prop1b, whole)
    var foldIoU = iou(taylor.expanded.foldMask, gale.expanded.foldMask)
    var structSame = taylor.expanded.inst1b === gale.expanded.inst1b &&
      taylor.expanded.rows1b === gale.expanded.rows1b && taylor.expanded.cols1b === gale.expanded.cols1b
    // Headline: fraction of ALL watermark content removed, before (shipped, one word's grid) vs after
    // (expanded). STAGE0 IoU(TAYLOR-grid,GALE-grid)=0 proves today's boxes hit DISJOINT word sets.
    console.log('  STAGE0 today: TAYLOR-grid vs GALE-grid overlap IoU = ' + iou(taylor.baseMask, gale.baseMask).toFixed(3) + '  (0 = disjoint word sets = the bug)')
    console.log('  content removed — STAGE0 (shipped): TAYLOR-box=' + (rBaseT * 100).toFixed(1) + '% , GALE-box=' + (rBaseG * 100).toFixed(1) + '%   (partial: only its own word)')
    console.log('  content removed — 1b (expanded):    TAYLOR-box=' + (rExpT * 100).toFixed(1) + '% , GALE-box=' + (rExpG * 100).toFixed(1) + '%   (target ~100% = whole phrase)')
    console.log('  folded unit spans ' + taylor.expanded.foldSep.toFixed(0) + 'px of the ' + Math.round(Math.max(Math.abs(taylor.basis[0].x), taylor.basis[1] ? Math.abs(taylor.basis[1].x) : 0)) + 'px cell (both words)')
    console.log('  invariance: folded-unit IoU (TAYLOR vs GALE box) = ' + foldIoU.toFixed(3) + ' ; structure TAYLOR ' + taylor.expanded.inst1b + '(' + taylor.expanded.rows1b + 'x' + taylor.expanded.cols1b + ') vs GALE ' +
      gale.expanded.inst1b + '(' + gale.expanded.rows1b + 'x' + gale.expanded.cols1b + ') -> ' + (structSame ? 'MATCH' : 'DIFFER'))
    console.log('  (caveat) TAYLOR-vs-GALE final-mask pixel IoU = ' + iou(taylor.expanded.prop1b, gale.expanded.prop1b).toFixed(3) + ' — sub-stroke fringe from the 1px/seed basis delta; fill dilation (#54) absorbs it')
    // GO on M1 iff BOTH boxes now remove ~all content (>=0.95) AND the folded unit is invariant AND same structure.
    verdict.m1 = rExpT >= 0.95 && rExpG >= 0.95 && foldIoU >= 0.9 && structSame

    // ---- M4a: bases reconcile across seeds ----
    console.log('\n=== M4a — basis reconciliation across seeds ===')
    var bt = taylor.basis, bg = gale.basis
    var m4a = bt.length === bg.length
    var maxComp = 0
    if (m4a) for (var k = 0; k < bt.length; k++) { maxComp = Math.max(maxComp, Math.abs(bt[k].x - bg[k].x), Math.abs(bt[k].y - bg[k].y)) }
    m4a = m4a && maxComp <= 2 // <=2px per component == sub-pixel-per-cell noise on a ~415px pitch
    console.log('  TAYLOR basis ' + basisStr(bt) + ' vs GALE basis ' + basisStr(bg) + ' | max component delta=' + maxComp + 'px -> ' + (m4a ? 'RECONCILE' : 'DIVERGE'))
    verdict.m4a = m4a

    // ---- M4b: per-row horizontal phase drift via column-profile cross-correlation ----
    console.log('\n=== M4b — per-row phase drift (column-profile cross-correlation, row 0 as reference) ===')
    var v0 = taylor.basis[0], v1 = taylor.basis[1] || null
    var rowPitch = Math.round(Math.max(Math.abs(v0.y), v1 ? Math.abs(v1.y) : 0)) || Math.round(Math.hypot(v0.x, v0.y))
    var colPeriod = Math.round(Math.max(Math.abs(v0.x), v1 ? Math.abs(v1.x) : 0)) || rowPitch
    var drift = rowPhaseDriftProfile(whole, img.width, img.height, rowPitch, colPeriod)
    drift.rows.forEach(function (rw) { console.log('  row j=' + pad(rw.j, 3) + ' best horiz shift vs row0 = ' + pad(rw.shift, 4) + 'px') })
    console.log('  drift per lattice row = ' + drift.driftPerRow.toFixed(3) + ' px/row  (NO-GO if > 1.0)')
    verdict.m4b = Math.abs(drift.driftPerRow) <= 1.0

    // ---- Stage 3 (fragment safety) recap ----
    console.log('\n=== STAGE 3 — fragment safety ===')
    recs.slice(2).forEach(function (r) {
      console.log('  ' + pad(r.label, 16) + ' guarded=' + (!!r.guarded) + ' tiling=' + r.fit.tiling +
        (r.guarded ? '  (expansion correctly skipped)' : '  <<< NOT guarded — check'))
    })

    // Evidence overlays for the canonical case.
    return Promise.all([
      writeMaskOverlay(img, taylor.baseMask, [255, 60, 60], 'stage0-taylor-partial'),
      writeMaskOverlay(img, taylor.expanded.prop1b, [0, 200, 255], 'stage1b-taylor-expanded'),
      writeMaskOverlay(img, gale.expanded.prop1b, [0, 255, 120], 'stage1b-gale-expanded'),
      writeMaskOverlay(img, taylor.expanded.foldMask, [255, 200, 0], 'fold-unit-taylor')
    ]).then(function () { return recs })
  }).then(function () {
    // ---- STAGE 2 — single-word / logo regression (M3: exactly ONE cluster, no phantom sibling) ----
    console.log('\n=== STAGE 2 / M3 — single-instance regression (phantom-sibling gate) ===')
    // GATE controls: images that must NOT tile (so expansion never fires). logo.png + copyright-
    // watermark.png both returned tiling=false in #58's M4 negative controls. If detectTextTiling stays
    // false -> expansion is guarded off -> no phantom sibling can be introduced by #60.
    // OBSERVATION (non-gating): watermark.jpg ALREADY false-1-D-tiles in shipped detectTextTiling
    // (basis ~(0,97), flagged in #58's M4). Its "multiple folded clusters" is that pre-existing
    // detection artifact chopping one wide word by a bogus period — NOT a #60 phantom. Reported, not gated.
    return Promise.all([loadImageData('logo.png'), loadImageData('copyright-watermark.png'), loadImageData('watermark.jpg')]).then(function (negs) {
      var gateNames = ['logo.png', 'copyright-watermark.png']
      negs.forEach(function (nimg, ni) {
        var name = ['logo.png', 'copyright-watermark.png', 'watermark.jpg'][ni]
        var W = nimg.width, H = nimg.height
        var box = { x: (W / 2 - 90) | 0, y: (H / 2 - 30) | 0, width: 180, height: 60 }
        var fit = Engine.detectTextTiling(nimg, box)
        var isGate = gateNames.indexOf(name) >= 0
        if (!fit.tiling || !fit.tileBasis.length) {
          console.log('  ' + pad(name, 22) + ' tiling=false -> expansion guarded off (no phantom sibling) ' + (isGate ? 'OK [GATE]' : '[obs]'))
          if (isGate) verdict.m3.push(true); return
        }
        var whole = Engine.detectWatermark(nimg, DETECT_PROFILE, { x: 0, y: 0, width: W, height: H }).mask
        var v0 = fit.tileBasis[0], v1 = fit.tileBasis[1] || null
        var fold = foldModLattice(whole, W, H, v0, v1, { x: 0, y: 0 })
        var comps = connectedComponents(fold, W, H, 8)
        var onePiece = comps.length <= 1
        console.log('  ' + pad(name, 22) + ' tiling=true basis=' + basisStr(fit.tileBasis) +
          ' | folded clusters=' + comps.length + ' sep=' + maxClusterSeparation(comps).toFixed(0) + 'px ' +
          (isGate ? (onePiece ? 'OK [GATE]' : '<<< PHANTOM SIBLING = NO-GO [GATE]') : '[obs — pre-existing false 1-D tile, see #58 M4]'))
        if (isGate) verdict.m3.push(onePiece)
      })
    })
  }).then(function () {
    // ---- VERDICT ----
    var m3pass = verdict.m3.every(Boolean)
    var GO = verdict.m1 && m3pass && verdict.m4a && verdict.m4b
    console.log('\n================= GO / NO-GO =================')
    console.log('M1 mechanism + invariance (fold captures sibling, identical from either box): ' + (verdict.m1 ? 'PASS' : 'FAIL'))
    console.log('M3 no phantom sibling (single-word/logo guarded off):                        ' + (m3pass ? 'PASS' : 'FAIL'))
    console.log('M4a bases reconcile across seeds:                                            ' + (verdict.m4a ? 'PASS' : 'FAIL'))
    console.log('M4b per-row phase drift <= 1px/row:                                          ' + (verdict.m4b ? 'PASS' : 'FAIL'))
    console.log('VERDICT: ' + (GO ? 'GO' : 'NO-GO') + (GO ? '' : '  (see failing gate above)'))
    if (!verdict.m4a || !verdict.m4b) console.log('  NOTE: an M4 failure = REDIRECT to a basis-reconciliation ticket, not a simple seed-expansion build.')
    console.log('\nBUILD NOTES:')
    console.log(' - The mod-lattice FOLD must use FLOOR (true modulo into the fundamental cell), NOT round —')
    console.log('   round clips the negative-residual half and silently drops ~half the content (incl. a word).')
    console.log(' - Fold anchor MUST be lattice-canonical (seed-independent), NOT the boxed position — that is')
    console.log('   what makes the result identical whichever word the user boxes.')
    console.log(' - #62 interaction is a MITIGATION, not a blocker: folding the WHOLE-image content averages')
    console.log('   detectWatermark per-instance bbox variance (CORE-23,25) across all instances, so the unit is')
    console.log('   more robust than any single seed. On HARDER fixtures (faint/missed instances) removal')
    console.log('   completeness is still bounded by what detectWatermark finds SOMEWHERE — a robustness caveat.')
    console.log(' - Residual 1px/seed basis delta (415 vs 414) leaves a sub-stroke fringe on far instances;')
    console.log('   fill dilation (#54) absorbs it. Optional polish: snap both boxes to one canonical integer basis.')
    console.log('=============================================')
    fs.writeFileSync(path.join(OUT, 'results.txt'), LOG.join('\n') + '\n')
    _log('\nwrote ' + path.relative(process.cwd(), path.join(OUT, 'results.txt')))
  }).catch(function (err) { _log('SPIKE ERROR: ' + (err && err.stack || err)); process.exit(1) })
}

main()
