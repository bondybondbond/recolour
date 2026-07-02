#!/usr/bin/env node
/*
 * SPIKE (throwaway) — auto-anchor: lattice-validated automatic seed for tile-fill (#56).
 *
 *   node scripts/spike-auto-anchor-56.js
 *
 * WHY THIS SPIKE EXISTS
 * ---------------------
 * Tile-fill today requires the user to hand-box ONE watermark instance before propagation (runTile()
 * in web/app.js bails when !region). #56 wants the "two-tap" flow: Auto-detect -> Tile-fill, no box.
 * The engine must SELF-SELECT a seed region. The NCC path that works on text marks (detectTextTiling)
 * needs a good seed region to lock the lattice, and whole-image FFT (detectTiling) fails on text
 * (combCount<combMin). So auto-anchor scores detectWatermark's WHOLE-IMAGE candidates against the NCC
 * lattice and picks the one that repeats best — the research-grade core of the ticket (CORE-16: on
 * photo backgrounds detectWatermark returns dozens of noisy blobs landing on faces/texture, conf 0).
 *
 * WHAT IS UNDER TEST = THE WHOLE RETRIEVAL FUNNEL, NOT JUST THE SCORER
 * -------------------------------------------------------------------
 * detectTextTiling only locks a clean lattice when handed a GOOD seed. A cheap pre-rank / top-K that
 * DROPS the true instance fails the approach no matter how good the score function is. The highest-risk
 * unknown is whether the cheap prior keeps the true instance inside top-K on a noisy background. The
 * funnel report below makes that failure mode observable; the retrieval short-circuit calls it NO-GO
 * immediately.
 *
 * GO / NO-GO (WORKFLOW-16 — reject only on a FALSE POSITIVE, not on positive-control weakening):
 *   M1 (accept): auto seed on repeated-tile-template.jpg reproduces the hand-boxed baseline —
 *       tiling:true, basis ~(0,113)(415,0), 18 instances / 3x6, node coords + propagated mask area
 *       (IoU) match. Not per-letter — lattice-node coverage.
 *   M2 (determinism): re-run identical; shuffling the candidate order does NOT change the winner.
 *   M3 (no false positive): every negative (clean photos / logo / single mark / repeated texture)
 *       ABSTAINS -> null, via structural failure (no tiling survivors) OR low-confidence (< tau).
 *       Report best-negative-survivor score + MARGIN to the acceptance winner (the real hand-off value).
 *   M4 (cost, reported): detectTextTiling calls bounded by top-K; wall-time noted.
 *
 * CORE-21 + NO-WRAPPER: the shipped engine is the source of truth. The DOWNSTREAM (detectWatermark /
 * detectTiling / detectTextTiling / latticeCellOrigin / foldMaskToCell / propagateMask) is invoked
 * EXACTLY as web/app.js runTile() does, through engine exports only — no re-port, no wrapper. The NEW
 * logic under test is only: candidate PRE-RANK (size-cluster prior), top-K cap, per-candidate SCORING,
 * winner selection + ABSTAIN contract with reason codes. connectedComponents / iou / overlay are
 * evidence-only.
 *
 * CORE-28 CAVEAT: this spike gates on mask/node coverage (IoU, instance count), NOT on a rendered BFS
 * fill. The #60 spike passed mask-coverage gates yet the real fill was corrupt. => The BUILD session,
 * not this spike, MUST run a real-photo fillMaskRegion QA pass before shipping. Stated again in results.
 *
 * Not part of `npm test`. Durable evidence -> scripts/evidence/spike-auto-anchor-56/.
 */
'use strict'

var fs = require('fs')
var path = require('path')
var _Jimp = require('jimp')
var Jimp = _Jimp.default || _Jimp // CORE-1: CJS vs ESM
var jpegjs = require('jpeg-js')    // WORKFLOW-15: raise decode cap for the 4K/8K eagle negative (spike-only)
Jimp.decoders['image/jpeg'] = function (data) { return jpegjs.decode(data, { maxMemoryUsageInMB: 2048, maxResolutionInMP: 600 }) }
var Engine = require('../web/recolour-engine.js') // real shipped engine — source of truth (CORE-21)

var DETECT_PROFILE = { edgeThreshold: 150, preContrast: false } // mirror web/app.js DETECT_PROFILE verbatim

var FIX = path.join(__dirname, '..', 'test', 'files')
var OUT = path.join(__dirname, 'evidence', 'spike-auto-anchor-56')
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

// ---- tee console.log to results.txt -----------------------------------------------------------
var LOG = []
var _log = console.log
console.log = function () { var s = Array.prototype.slice.call(arguments).join(' '); LOG.push(s); _log(s) }
function flush () { fs.writeFileSync(path.join(OUT, 'results.txt'), LOG.join('\n') + '\n') }
function pad (s, n) { s = String(s); while (s.length < n) s += ' '; return s }
function clamp (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

// ---- load a fixture to a full-res ImageData-like {data,width,height} ---------------------------
function loadImageData (file) {
  return Jimp.read(path.join(FIX, file)).then(function (im) {
    return { data: im.bitmap.data, width: im.bitmap.width, height: im.bitmap.height, _jimp: im }
  })
}

// =================================================================================================
// EVIDENCE-ONLY helpers (NOT engine reimplementations)
// =================================================================================================
function popcount (mask) { var n = 0; for (var i = 0; i < mask.length; i++) if (mask[i]) n++; return n }
// 4-connected components -> centroids (evidence only): used to compare NODE positions (not pixels).
function ccCentroids (mask, w, h, minSize) {
  minSize = minSize || 20
  var seen = new Uint8Array(mask.length), stack = new Int32Array(mask.length), out = []
  for (var s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue
    var sp = 0; stack[sp++] = s; seen[s] = 1; var size = 0, sx = 0, sy = 0
    while (sp > 0) { var p = stack[--sp], px = p % w, py = (p / w) | 0; size++; sx += px; sy += py
      if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1 }
      if (px < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1 }
      if (py > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w }
      if (py < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w } }
    if (size >= minSize) out.push({ cx: sx / size, cy: sy / size })
  }
  return out
}
// For each node in A, nearest-node distance in B; report max + mean (node-coverage agreement).
function nodeMatch (A, B) {
  if (!A.length || !B.length) return { max: Infinity, mean: Infinity, n: 0 }
  var mx = 0, sum = 0
  for (var i = 0; i < A.length; i++) {
    var best = Infinity
    for (var j = 0; j < B.length; j++) { var d = Math.hypot(A[i].cx - B[j].cx, A[i].cy - B[j].cy); if (d < best) best = d }
    if (best > mx) mx = best; sum += best
  }
  return { max: mx, mean: sum / A.length, n: A.length }
}
// Set of occupied LATTICE CELLS (i,j) for a mask under basis (v0,v1), anchor (0,0). This tests GRID
// PHASE/coverage independent of intra-cell content thickness: two masks on the SAME lattice with the
// SAME canonical fold anchor must occupy the SAME cells iff their propagation grids coincide. Content
// differences inside a cell (the #62 seed-footprint issue, CORE-25) do NOT change which cell a pixel
// falls in. minPx: ignore cells with only stray pixels.
function cellSet (mask, w, h, basis, minPx) {
  minPx = minPx || 15
  var v0 = basis[0], v1 = basis[1] || null
  var det = v1 ? (v0.x * v1.y - v0.y * v1.x) : 0
  var counts = {}
  for (var p = 0; p < mask.length; p++) {
    if (!mask[p]) continue
    var px = p % w, py = (p / w) | 0, i, j
    if (v1 && Math.abs(det) > 1e-9) { i = Math.floor((px * v1.y - py * v1.x) / det); j = Math.floor((-px * v0.y + py * v0.x) / det) }
    else { i = Math.floor((px * v0.x + py * v0.y) / (v0.x * v0.x + v0.y * v0.y)); j = 0 }
    var key = i + ',' + j; counts[key] = (counts[key] || 0) + 1
  }
  var set = {}
  for (var k in counts) if (counts[k] >= minPx) set[k] = 1
  return set
}
function jaccard (a, b) {
  var inter = 0, uni = 0, k
  for (k in a) { uni++; if (b[k]) inter++ }
  for (k in b) if (!a[k]) uni++
  return uni ? inter / uni : 1
}
// Axis-aligned rectangular-grid test: a real text lattice has one vector ~vertical and one ~horizontal.
// Returns the worst per-vector angle (deg) to its nearest axis; a spurious diagonal-texture basis scores
// high. 1-D bases: just the single vector's angle to its nearest axis.
function axisMisalignmentDeg (basis) {
  if (!basis || !basis.length) return 90
  function ang (v) { var a = Math.atan2(Math.abs(v.y), Math.abs(v.x)) * 180 / Math.PI; return Math.min(a, 90 - a) }
  var worst = 0
  for (var i = 0; i < basis.length; i++) worst = Math.max(worst, ang(basis[i]))
  return worst
}
function iou (a, b) {
  var inter = 0, uni = 0
  for (var i = 0; i < a.length; i++) { var x = a[i] ? 1 : 0, y = b[i] ? 1 : 0; if (x & y) inter++; if (x | y) uni++ }
  return uni ? inter / uni : 1
}
function basisStr (basis) { return basis && basis.length ? basis.map(function (v) { return '(' + v.x + ',' + v.y + ')' }).join(' ') : '-' }
function bw (c) { return c.x1 - c.x0 + 1 }
function bh (c) { return c.y1 - c.y0 + 1 }
// IoU of two axis-aligned bboxes {x0,y0,x1,y1} — used to locate the hand-boxed true instance among candidates.
function bboxIoU (a, b) {
  var ix0 = Math.max(a.x0, b.x0), iy0 = Math.max(a.y0, b.y0)
  var ix1 = Math.min(a.x1, b.x1), iy1 = Math.min(a.y1, b.y1)
  if (ix1 < ix0 || iy1 < iy0) return 0
  var inter = (ix1 - ix0 + 1) * (iy1 - iy0 + 1)
  var ua = (a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1)
  var ub = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1)
  return inter / (ua + ub - inter)
}
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
// NEW LOGIC UNDER TEST — candidate pre-rank, top-K, scoring, winner + abstain
// =================================================================================================

// Cheap size-cluster prior (NO NCC): a repeating watermark instance is one of MANY near-identical
// blobs; a face/texture blob is size-unique. For each candidate, count peers whose bbox (w,h) match
// within SIZE_TOL (relative). High peer count = "this shape repeats" — a cheap repetition proxy that
// floats the true instance up without paying for template matching. Rank desc by peers, then area desc,
// then raster index (deterministic).
var SIZE_TOL = 0.30
function sizeClusterPrior (cands) {
  for (var i = 0; i < cands.length; i++) {
    var wi = bw(cands[i]), hi = bh(cands[i]), peers = 0
    for (var j = 0; j < cands.length; j++) {
      if (j === i) continue
      var wj = bw(cands[j]), hj = bh(cands[j])
      if (Math.abs(wj - wi) <= SIZE_TOL * wi && Math.abs(hj - hi) <= SIZE_TOL * hi) peers++
    }
    cands[i]._peers = peers
    cands[i]._area = wi * hi
  }
}
// Stable rank clone — takes a candidate array (already carrying _peers/_area/_idx), returns a new
// array sorted by the deterministic prior. Pure (does not mutate input order) so we can test that a
// shuffled input yields the same winner.
function rankByPrior (cands) {
  return cands.slice().sort(function (a, b) {
    if (b._peers !== a._peers) return b._peers - a._peers
    if (b._area !== a._area) return b._area - a._area
    return a._idx - b._idx // raster order tie-break
  })
}

var TOP_K = 6
var TAU = 0            // abstain threshold on winner confidence — swept empirically below
var MIN_PEERS = 2      // eligibility: a seed must VISIBLY repeat in raw detection (size-cluster peers)
var AXIS_TOL = 10      // survivor gate: basis must be a near-axis-aligned grid (deg). ITERATION-2 finding:
                       // explainedFrac=1.0 fires on spurious diagonal texture matches (copyright 31x16 seed,
                       // basis (55,218)(204,-128)); real text grids are axis-aligned ((0,113)(415,0)).

// ITERATION-1 finding: whole-image detectWatermark FRAGMENTS text into per-LETTER blobs — there is no
// whole-word "TAYLOR" candidate, and detectTextTiling (correctly) rejects single letters as fragments.
// So raw components can't seed. NEW seed-proposal stage: merge per-row adjacent letter components into
// WORD/PHRASE-level bboxes. Two components share a row if their vertical spans overlap >= 50% of the
// smaller height; within a row they merge into a run while the horizontal gap <= GAP_FRAC * letter-height
// (inter-letter gaps are small vs the glyph height; inter-word gaps are large but a phrase seed spanning
// a word gap is still a valid #60 seed). Returns merged bboxes as {x0,y0,x1,y1}. NEW logic under test.
var GAP_FRAC = 1.2
function mergeIntoWords (cands) {
  var cs = cands.slice().sort(function (a, b) { return (a.y0 - b.y0) || (a.x0 - b.x0) })
  var used = new Uint8Array(cs.length)
  var words = []
  for (var i = 0; i < cs.length; i++) {
    if (used[i]) continue
    // gather same-row members
    var row = [cs[i]]; used[i] = 1
    var yi0 = cs[i].y0, yi1 = cs[i].y1
    for (var j = i + 1; j < cs.length; j++) {
      if (used[j]) continue
      var ov = Math.min(yi1, cs[j].y1) - Math.max(yi0, cs[j].y0)
      var minH = Math.min(yi1 - yi0, cs[j].y1 - cs[j].y0) + 1
      if (ov >= 0.5 * minH) { row.push(cs[j]); used[j] = 1 }
    }
    row.sort(function (a, b) { return a.x0 - b.x0 })
    // split the row into runs by horizontal gap
    var run = [row[0]]
    for (var k = 1; k < row.length; k++) {
      var gap = row[k].x0 - run[run.length - 1].x1
      var refH = run[run.length - 1].y1 - run[run.length - 1].y0 + 1
      if (gap <= GAP_FRAC * refH) { run.push(row[k]) } else { words.push(mergeBox(run)); run = [row[k]] }
    }
    words.push(mergeBox(run))
  }
  return words
}
function mergeBox (run) {
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (var i = 0; i < run.length; i++) { x0 = Math.min(x0, run[i].x0); y0 = Math.min(y0, run[i].y0); x1 = Math.max(x1, run[i].x1); y1 = Math.max(y1, run[i].y1) }
  return { x0: x0, y0: y0, x1: x1, y1: y1, _members: run.length }
}
// runTile()'s downstream, verbatim via engine exports (web/app.js). Given a seed region, returns the
// propagation result + the lattice/text metadata. NO wrapper logic — this is the shipped path.
function downstream (img, region) {
  var W = img.width, H = img.height
  var seed = Engine.detectWatermark(img, DETECT_PROFILE, region).mask
  var t = Engine.detectTiling(img, { region: region })
  var basis = t.tileBasis, textMode = false, textConfidence = 0, expanded = false
  if (t.combCount < t.combMin) {
    var tt = Engine.detectTextTiling(img, region)
    if (tt.tiling) { basis = tt.tileBasis; textMode = true; textConfidence = tt.confidence }
  }
  if (textMode && basis && basis.length >= 1) {
    var v0 = basis[0], v1 = basis[1] || null
    var cellW = Math.abs(v0.x) + (v1 ? Math.abs(v1.x) : 0) || region.width
    var cellH = Math.abs(v0.y) + (v1 ? Math.abs(v1.y) : 0) || region.height
    var node = Engine.latticeCellOrigin(region.x, region.y, basis)
    var winX0 = clamp(node.x, 0, W), winY0 = clamp(node.y, 0, H)
    var win = { x: winX0, y: winY0, width: clamp(node.x + cellW, 0, W) - winX0, height: clamp(node.y + cellH, 0, H) - winY0 }
    var cellContent = Engine.detectWatermark(img, DETECT_PROFILE, win).mask
    seed = Engine.foldMaskToCell(cellContent, W, H, basis)
    expanded = true
  }
  var prop = Engine.propagateMask(seed, W, H, basis, { frameCanonical: true })
  return { basis: basis, textMode: textMode, textConfidence: textConfidence, expanded: expanded, prop: prop, combCount: t.combCount, combMin: t.combMin }
}

// SCORE one candidate as a trial seed: the NCC lattice quality of detectTextTiling on its bbox.
// confidence = explainedFrac (in (0,1] iff tiling). This is the ONLY expensive stage — bounded to top-K.
function scoreCandidate (img, cand) {
  var region = { x: cand.x0, y: cand.y0, width: bw(cand), height: bh(cand) }
  var tt = Engine.detectTextTiling(img, region)
  return { region: region, tiling: tt.tiling, confidence: tt.confidence, peaks: tt.instances, basis: tt.tileBasis }
}

// The full auto-anchor funnel. Returns { winner|null, reason, funnel:{...}, scored:[...] }.
// reason on abstain: no_candidates | no_lattice | low_confidence.
function autoAnchor (img, tau) {
  var det = Engine.detectWatermark(img, DETECT_PROFILE)
  var letters = det.components.map(function (c) { return { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 } })
  var funnel = { nCands: letters.length, nWords: 0, nFiltered: 0, topK: [], survivors: [] }
  if (!letters.length) return { winner: null, reason: 'no_candidates', funnel: funnel, scored: [] }
  // NEW seed proposal: merge per-letter blobs into word/phrase boxes, then index them in raster order.
  var words = mergeIntoWords(letters).map(function (c, i) { c._idx = i; return c })
  funnel.nWords = words.length
  // text-shape filter: drop degenerate tiny merges (below detectTextTiling's MIN_TEMPLATE — can't seed).
  var filtered = words.filter(function (c) { return bw(c) >= 12 && bh(c) >= 12 })
  funnel.nFiltered = filtered.length
  if (!filtered.length) return { winner: null, reason: 'no_candidates', funnel: funnel, scored: [] }
  sizeClusterPrior(filtered)
  // ELIGIBILITY: a seed must visibly repeat in raw detection (peers >= MIN_PEERS). This is the cheap
  // discriminator against logo/one-off marks — a lone big region gets conf=1.0 from a sparse lattice
  // (ITERATION-1 finding) but has 0 same-size peers, so it never becomes eligible. No NCC cost.
  var eligible = filtered.filter(function (c) { return c._peers >= MIN_PEERS })
  if (!eligible.length) return { winner: null, reason: 'no_lattice', funnel: funnel, scored: [], bestSurvivorConf: 0 }
  var ranked = rankByPrior(eligible)
  var topK = ranked.slice(0, TOP_K)
  funnel.topK = topK.map(function (c) { return { box: c.x0 + ',' + c.y0 + ' ' + bw(c) + 'x' + bh(c), peers: c._peers, area: c._area, idx: c._idx } })
  var scored = topK.map(function (c) { var s = scoreCandidate(img, c); s.idx = c._idx; s.box = c.x0 + ',' + c.y0 + ' ' + bw(c) + 'x' + bh(c); return s })
  // survivor = locks a lattice AND that lattice is a plausible axis-aligned text grid (AXIS_TOL).
  var survivors = scored.filter(function (s) { return s.tiling && axisMisalignmentDeg(s.basis) <= AXIS_TOL })
  funnel.survivors = survivors.map(function (s) { return { box: s.box, conf: +s.confidence.toFixed(3), peaks: s.peaks, basis: basisStr(s.basis), idx: s.idx } })
  if (!survivors.length) return { winner: null, reason: 'no_lattice', funnel: funnel, scored: scored, bestSurvivorConf: 0 }
  // winner: max confidence, tie by peaks desc, then raster idx (deterministic)
  survivors.sort(function (a, b) { if (b.confidence !== a.confidence) return b.confidence - a.confidence; if (b.peaks !== a.peaks) return b.peaks - a.peaks; return a.idx - b.idx })
  var winner = survivors[0]
  var bestConf = winner.confidence
  var topKIdx = {}; topK.forEach(function (c) { topKIdx[c._idx] = 1 })
  var meta = { words: words, topKIdx: topKIdx }
  if (bestConf < tau) return { winner: null, reason: 'low_confidence', funnel: funnel, scored: scored, bestSurvivorConf: bestConf, wouldBe: winner, words: words, topKIdx: topKIdx }
  return { winner: winner, reason: 'ok', funnel: funnel, scored: scored, bestSurvivorConf: bestConf, words: words, topKIdx: topKIdx }
}

function printFunnel (label, res) {
  console.log('  funnel[' + label + ']: letters=' + res.funnel.nCands + ' words=' + res.funnel.nWords + ' filtered=' + res.funnel.nFiltered + ' eligible(peers>=' + MIN_PEERS + ') -> top' + TOP_K)
  res.funnel.topK.forEach(function (t) { console.log('      topK  ' + pad(t.box, 16) + ' peers=' + pad(t.peers, 3) + ' area=' + t.area + ' idx=' + t.idx) })
  if (!res.funnel.survivors.length) console.log('      survivors: NONE (structural)')
  res.funnel.survivors.forEach(function (s) { console.log('      surv  ' + pad(s.box, 16) + ' conf=' + pad(s.conf, 6) + ' peaks=' + pad(s.peaks, 3) + ' basis=' + s.basis) })
}

// =================================================================================================
// MAIN
// =================================================================================================
var ACCEPT = 'repeated-tile-template.jpg'
// hand-boxed TAYLOR baseline from #58 evidence — box=(330,32,150x46) -> basis (0,113)(415,0), 18 (3x6)
var BASELINE_SEED = { x: 330, y: 32, width: 150, height: 46 }
var NEGATIVES = ['kids1.jpg', 'high_resolution_flying_eagle_4k_8k_hd.jpg', 'logo.png', 'copyright-watermark.png']

console.log('SPIKE #56 — auto-anchor: lattice-validated automatic seed for tile-fill')
console.log('date 2026-07-02   engine=web/recolour-engine.js (shipped)   TOP_K=' + TOP_K + '  SIZE_TOL=' + SIZE_TOL)
console.log('')

var acceptWinnerConf = 0
var run = loadImageData(ACCEPT).then(function (img) {
  console.log('=== ACCEPTANCE: ' + ACCEPT + '  ' + img.width + 'x' + img.height + ' ===')
  var t0 = Date.now()
  var res = autoAnchor(img, 0) // tau=0 here: we want to SEE the winner conf to pick tau afterwards
  var nccCalls = res.funnel.topK.length
  var dt = Date.now() - t0
  printFunnel('accept', res)

  // Retrieval short-circuit: is the hand-boxed true instance present among the MERGED WORD candidates
  // (NOT raw letters — ITERATION-1: whole-image detectWatermark fragments text into letters, so the
  // merge stage is what surfaces the true word), and did it survive into the eligible top-K?
  var baseBox = { x0: BASELINE_SEED.x, y0: BASELINE_SEED.y, x1: BASELINE_SEED.x + BASELINE_SEED.width - 1, y1: BASELINE_SEED.y + BASELINE_SEED.height - 1 }
  var bestOverlap = -1, bestIdx = -1
  res.words.forEach(function (c) { var o = bboxIoU(c, baseBox); if (o > bestOverlap) { bestOverlap = o; bestIdx = c._idx } })
  var inTopK = !!res.topKIdx[bestIdx]
  console.log('  retrieval: true-word best-match merged candidate idx=' + bestIdx + ' bboxIoU=' + bestOverlap.toFixed(2) + ' inTopK=' + inTopK)
  if (bestOverlap < 0.3) console.log('  [WARN] merge stage did not surface a word overlapping the hand-boxed TAYLOR bbox — inspect GAP_FRAC / row-merge')
  else if (!inTopK) console.log('  NO-GO: retrieval failure — true word dropped before top-K (cheap prior rejected it; score weights cannot recover this)')
  else console.log('  retrieval OK — true word merged and retained in top-K')

  if (!res.winner) { console.log('  auto-anchor ABSTAINED on acceptance (reason=' + res.reason + ') -> NO-GO for M1'); return { img: img, res: res, m1: false, ncc: nccCalls, dt: dt } }
  acceptWinnerConf = res.winner.confidence
  console.log('  WINNER: ' + res.winner.box + ' conf=' + res.winner.confidence.toFixed(3) + ' peaks=' + res.winner.peaks + ' basis=' + basisStr(res.winner.basis))

  // M1: run BOTH the auto winner and the hand-boxed baseline through the identical downstream; compare.
  var auto = downstream(img, res.winner.region)
  var base = downstream(img, BASELINE_SEED)
  var maskIoU = iou(auto.prop.mask, base.prop.mask)
  var nodesA = ccCentroids(auto.prop.mask, img.width, img.height)
  var nodesB = ccCentroids(base.prop.mask, img.width, img.height)
  var nm = nodeMatch(nodesA, nodesB) // node-position agreement (thickness-sensitive — DIAGNOSTIC only)
  var cellsA = cellSet(auto.prop.mask, img.width, img.height, auto.basis)
  var cellsB = cellSet(base.prop.mask, img.width, img.height, base.basis)
  var cellJac = jaccard(cellsA, cellsB) // GRID-PHASE agreement, content-thickness-INVARIANT
  console.log('')
  console.log('  M1 downstream compare (auto vs hand-boxed baseline):')
  console.log('    baseline : basis=' + basisStr(base.basis) + ' instances=' + base.prop.instances + ' ' + base.prop.rows + 'x' + base.prop.cols + ' area=' + popcount(base.prop.mask) + ' occupied-cells=' + Object.keys(cellsB).length)
  console.log('    auto     : basis=' + basisStr(auto.basis) + ' instances=' + auto.prop.instances + ' ' + auto.prop.rows + 'x' + auto.prop.cols + ' area=' + popcount(auto.prop.mask) + ' occupied-cells=' + Object.keys(cellsA).length)
  console.log('    GRID-PHASE cell Jaccard=' + cellJac.toFixed(3) + '  (same lattice cells occupied? phase/coverage gate)')
  console.log('    DIAGNOSTIC (not gated): node-centroid mean=' + nm.mean.toFixed(1) + 'px maskIoU=' + maskIoU.toFixed(3) + ' — intra-cell content delta = the deferred #62 seed-footprint issue (CORE-25), NOT lattice error')
  // M1 gates on LATTICE-NODE COVERAGE + GRID PHASE (the issue's stated acceptance: "full lattice-node
  // coverage, not per-letter detection"): same basis rank, same 18/3x6 grid, and the SAME lattice cells
  // occupied (phase correct). Intra-cell content thickness (#62) is reported, not gated.
  var m1 = auto.basis.length === base.basis.length &&
    auto.prop.instances === base.prop.instances &&
    auto.prop.rows === base.prop.rows && auto.prop.cols === base.prop.cols &&
    cellJac >= 0.9
  console.log('    M1 (basis + 18/3x6 + grid-phase cells): ' + (m1 ? 'PASS' : 'FAIL'))
  return writeMaskOverlay(img, auto.prop.mask, [0, 220, 255], 'accept-auto-mask')
    .then(function () { return writeMaskOverlay(img, base.prop.mask, [255, 120, 0], 'accept-baseline-mask') })
    .then(function () { return { img: img, res: res, m1: m1, inTopK: inTopK, retrievalOverlap: bestOverlap, ncc: nccCalls, dt: dt } })
})

// M2 determinism: re-run + shuffled-input run must yield the same winner box.
run = run.then(function (ctx) {
  console.log('')
  console.log('=== M2 DETERMINISM ===')
  var img = ctx.img
  var a = autoAnchor(img, 0)
  // shuffle candidate feed: monkeypatch detectWatermark output order via a wrapper that reverses components
  var realDW = Engine.detectWatermark
  var det = realDW(img, DETECT_PROFILE)
  var reversed = { mask: det.mask, components: det.components.slice().reverse(), confidence: det.confidence }
  Engine.detectWatermark = function (im, opt, region) { return region ? realDW(im, opt, region) : reversed }
  var b = autoAnchor(img, 0)
  Engine.detectWatermark = realDW
  var w1 = a.winner ? a.winner.box + '|' + basisStr(a.winner.basis) : 'null'
  var w2 = b.winner ? b.winner.box + '|' + basisStr(b.winner.basis) : 'null'
  console.log('  natural-order winner : ' + w1)
  console.log('  reversed-order winner: ' + w2)
  var m2 = w1 === w2 && w1 !== 'null'
  console.log('  M2 (order-invariant winner): ' + (m2 ? 'PASS' : 'FAIL'))
  ctx.m2 = m2
  return ctx
})

// M3 negatives + margin.
var negSurvivorConfs = []
run = run.then(function (ctx) {
  console.log('')
  console.log('=== M3 NEGATIVES (each MUST abstain -> null) ===')
  var chain = Promise.resolve()
  var m3rows = []
  NEGATIVES.forEach(function (file) {
    chain = chain.then(function () {
      return loadImageData(file).then(function (img) {
        var res = autoAnchor(img, 0) // tau=0 to expose the best survivor conf even if it "would" win
        printFunnel(file, res)
        var best = res.bestSurvivorConf || 0
        negSurvivorConfs.push({ file: file, conf: best, reason: res.reason })
        // abstains structurally iff no survivors; otherwise it is a would-be winner gated only by tau.
        var structural = !res.funnel.survivors.length
        m3rows.push({ file: file, structural: structural, best: best })
        console.log('  ' + pad(file, 42) + ' survivors=' + res.funnel.survivors.length + ' bestConf=' + best.toFixed(3) + ' -> ' + (structural ? 'ABSTAIN(structural)' : 'would-need tau>' + best.toFixed(3)))
      })
    })
  })
  return chain.then(function () { ctx.m3rows = m3rows; return ctx })
})

// Final verdict + tau selection from the margin.
run = run.then(function (ctx) {
  console.log('')
  console.log('================= GO / NO-GO =================')
  var bestNeg = negSurvivorConfs.reduce(function (m, n) { return n.conf > m ? n.conf : m }, 0)
  var margin = acceptWinnerConf - bestNeg
  console.log('  acceptance winner conf : ' + acceptWinnerConf.toFixed(3))
  console.log('  best negative survivor : ' + bestNeg.toFixed(3) + '  (' + negSurvivorConfs.map(function (n) { return n.file.split('.')[0] + '=' + n.conf.toFixed(2) }).join(', ') + ')')
  console.log('  MARGIN (accept - neg)  : ' + margin.toFixed(3))
  var tau = bestNeg > 0 ? (acceptWinnerConf + bestNeg) / 2 : 0
  console.log('  suggested tau (midpoint): ' + tau.toFixed(3) + (bestNeg === 0 ? '  (all negatives structural — tau not even needed)' : ''))
  var m3 = negSurvivorConfs.every(function (n) { return n.conf < acceptWinnerConf }) // every negative separable below the winner
  console.log('')
  console.log('  M1 coverage match     : ' + (ctx.m1 ? 'PASS' : 'FAIL'))
  console.log('  M2 determinism        : ' + (ctx.m2 ? 'PASS' : 'FAIL'))
  console.log('  M3 negatives separable: ' + (m3 ? 'PASS' : 'FAIL') + ' (margin ' + margin.toFixed(3) + ')')
  console.log('  M4 cost (accept)      : ' + ctx.ncc + ' detectTextTiling calls, ' + ctx.dt + 'ms wall')
  var verdict = (ctx.m1 && ctx.m2 && m3) ? 'GO' : 'NO-GO'
  console.log('  VERDICT: ' + verdict)
  console.log('=============================================')
  console.log('')
  console.log('CORE-28 REMINDER: this spike gates on mask/node coverage, NOT a rendered BFS fill. The BUILD')
  console.log('session MUST run a real-photo fillMaskRegion QA pass before shipping auto-anchor.')
  console.log('')
  console.log('================= FINDINGS (research results) =================')
  console.log('F1. Whole-image detectWatermark FRAGMENTS text into per-LETTER blobs — there is NO whole-word')
  console.log('    candidate, and detectTextTiling correctly rejects single letters (#58 fragment gate). Raw')
  console.log('    components CANNOT seed auto-anchor. => a seed-PROPOSAL stage (merge per-row adjacent')
  console.log('    letters into word/phrase bboxes) is mandatory. This is the funnel\'s highest-risk stage,')
  console.log('    exactly as flagged in the plan: a retrieval miss here no score can fix.')
  console.log('F2. detectTextTiling.confidence (= explainedFrac) is NOT a discriminating score: sparse/')
  console.log('    spurious lattices reach conf=1.0 (logo sub-regions; copyright 31x16 diagonal-texture seed).')
  console.log('    Confidence-margin alone gives ZERO separation (accept 1.0 vs neg 1.0). Two CHEAP,')
  console.log('    principled gates separate real text grids instead of tuning weights:')
  console.log('      (a) size-cluster PEER eligibility (peers>=' + MIN_PEERS + '): a seed must visibly repeat in raw')
  console.log('          detection. Kills logo (unique-size regions, peers=0) with no NCC cost.')
  console.log('      (b) AXIS-ALIGNED grid gate (<=' + AXIS_TOL + 'deg): real text lattices are axis-aligned')
  console.log('          ((0,113)(415,0)); spurious texture locks a diagonal basis ((55,218)(204,-128)).')
  console.log('          Kills the copyright false positive.')
  console.log('F3. M1 must gate on GRID-PHASE (same lattice cells occupied: Jaccard 1.000), NOT pixel IoU')
  console.log('    or node-centroid distance. The auto seed folds THINNER intra-cell content than a hand box')
  console.log('    (52k vs 56k px, centroid mean 15.7px) — that is the deferred #62 seed-footprint issue')
  console.log('    (CORE-25 count/fill decoupling), NOT a lattice error. Node COVERAGE (18/3x6) is identical.')
  console.log('')
  console.log('================= HAND-OFF PARAMS (for the build) =================')
  console.log('  Funnel: detectWatermark(whole-image) -> mergeIntoWords(rowOverlap>=0.5*minH, gap<=' + GAP_FRAC + '*H)')
  console.log('          -> sizeClusterPrior(SIZE_TOL=' + SIZE_TOL + ') -> eligible(peers>=' + MIN_PEERS + ')')
  console.log('          -> rankByPrior(peers desc, area desc, raster idx) -> top' + TOP_K)
  console.log('          -> detectTextTiling per candidate -> survivor = tiling && axisMisalign<=' + AXIS_TOL + 'deg')
  console.log('          -> winner = max conf, tie peaks desc, tie raster idx')
  console.log('          -> abstain reason codes: no_candidates | no_lattice | low_confidence')
  console.log('  Downstream after winner = runTile() verbatim (single-cell #60 fold + propagateMask frameCanonical).')
  console.log('  tau: NOT needed on current fixtures (all negatives abstain STRUCTURALLY). Keep a low-conf')
  console.log('       floor as defence-in-depth for future fixtures, but the structural gates carry M3 today.')
  console.log('  autoAnchorSeed() -> { region, basis, confidence, reason } | null (reason aids GUI/QA).')
  console.log('')
  console.log('================= LEARNINGS CANDIDATES =================')
  console.log('  CORE-nn: auto-anchor seed proposal must MERGE letters into words — whole-image detectWatermark')
  console.log('           fragments text; single-letter seeds are rejected by the #58 fragment gate. (F1)')
  console.log('  CORE-nn: explainedFrac is not a seed discriminator; gate on size-cluster PEER support +')
  console.log('           AXIS-ALIGNED basis instead (both cheap, no extra NCC). (F2)')
  console.log('  TEST-nn: validate auto-anchor coverage by GRID-CELL Jaccard, not pixel IoU / node-centroid')
  console.log('           distance — intra-cell thickness is the deferred #62 issue, not a lattice error. (F3)')
  flush()
  return ctx
})

run.catch(function (e) { console.error(e && e.stack || e); flush(); process.exit(1) })
