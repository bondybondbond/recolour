#!/usr/bin/env node
/*
 * SPIKE (throwaway) — position-invariant 2-D lattice fit for detectTextTiling (#58, T29 follow-up).
 *
 *   node scripts/spike-lattice-fit-58.js
 *
 * WHY THIS SPIKE EXISTS
 * ---------------------
 * detectTextTiling() (#53) locks ONE lattice axis reliably, but its second basis vector v1 comes
 * from a seed-LOCAL nearest-neighbour heuristic (recolour-engine.js:1324-1346). Same TAYLOR GALE
 * grid, different boxed instance -> different lattice:
 *   - box one word  -> v1 omitted        -> "6 instances in 1 row"  (5 rows missed)
 *   - box another   -> v1 at a subharmonic -> 76 instances (over-stamp, subharmonicWarning set)
 * Once #56 (auto-anchor) removes the human from seed selection this becomes silent + dangerous.
 *
 * This spike tests ONE question and builds nothing in web/ or src/:
 *
 *   Does a GLOBAL lattice fit over the whole NCC peak cloud (two shortest independent generating
 *   vectors via Lagrange-Gauss reduction) + deterministic subharmonic rejection yield a
 *   POSITION-INVARIANT 2-D basis — the SAME basis + instance count regardless of which instance was
 *   boxed — on test/files/repeated-tile-template.jpg, while staying quiet on clean/negative controls?
 *
 * [TRAP]: the #53 spike (scripts/spike-text-tiling.js) and the shipped engine peak-extraction stack
 * HAVE DIVERGED — the #53 spike downscales with Jimp's bilinear resize(), the engine uses an
 * area-average downscaleToLuma(). For #58 the ENGINE is the source of truth (the 6-vs-76 bug
 * reproduces through the shipped detectTextTiling), so this spike ports the ENGINE's front-end
 * verbatim (downscaleToLuma / fullLuma / fastNCC / extractTextPeaks) — NOT the #53 spike's — and
 * replaces ONLY the basis-derivation stage after the peak cloud exists.
 *
 * GO/NO-GO GATE (WORKFLOW-16): reject only on a FALSE POSITIVE (a negative control latching a clean
 * 2-D lattice, or M2 non-determinism). Positive-control coverage weakening is a reported caveat, not
 * a gate failure. Not part of `npm test`. Durable evidence -> scripts/evidence/spike-lattice-58/.
 */
'use strict'

var fs = require('fs')
var path = require('path')
var _Jimp = require('jimp')
var Jimp = _Jimp.default || _Jimp // CORE-1: CJS vs ESM
var Engine = require('../web/recolour-engine.js') // real shipped engine — reproduce the bug faithfully

var FIX = path.join(__dirname, '..', 'test', 'files')
var OUT = path.join(__dirname, 'evidence', 'spike-lattice-58')
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

// ---- load a fixture to a full-res ImageData-like {data,width,height} --------------------------
// detectTextTiling reads imageData.data (RGBA) at NATIVE resolution and does its own internal
// downscale — so we hand it the full frame, exactly like the GUI (canvas getImageData).
function loadImageData (file) {
  return Jimp.read(path.join(FIX, file)).then(function (im) {
    return { data: im.bitmap.data, width: im.bitmap.width, height: im.bitmap.height, _jimp: im }
  })
}

// =================================================================================================
// STAGE 0 — reproduce the 6-vs-76 bug through the REAL engine, to pin exact seed coordinates.
// =================================================================================================
function probeSeeds (img, seeds) {
  console.log('\n=== STAGE 0: engine detectTextTiling() over candidate seeds (real shipped code) ===')
  console.log('image ' + img.width + 'x' + img.height)
  seeds.forEach(function (s) {
    var r = Engine.detectTextTiling(img, s)
    var basis = r.tileBasis.map(function (v) { return '(' + v.x + ',' + v.y + ')' }).join(' ')
    // Also run propagateMask with a synthetic seed block at the box to get the STAMPED instance count
    // (what the GUI actually shows), mirroring runTile(): seed shape from detectWatermark, but for the
    // probe a filled box is enough to count lattice nodes.
    var seedMask = boxMask(img.width, img.height, s)
    var prop = Engine.propagateMask(seedMask, img.width, img.height, r.tileBasis)
    console.log(
      pad(s.label, 22) +
      ' box=(' + s.x + ',' + s.y + ',' + s.width + 'x' + s.height + ')' +
      ' tiling=' + r.tiling +
      ' peaks=' + r.instances +
      ' basisN=' + r.tileBasis.length +
      ' basis=' + (basis || '-') +
      ' | stamped=' + prop.instances + ' (' + prop.rows + 'r x ' + prop.cols + 'c)' +
      (prop.subharmonicWarning ? ' SUBHARM' : '')
    )
  })
}

function boxMask (W, H, s) {
  var m = new Uint8Array(W * H)
  var x1 = Math.min(W, s.x + s.width), y1 = Math.min(H, s.y + s.height)
  for (var y = s.y; y < y1; y++) for (var x = s.x; x < x1; x++) m[y * W + x] = 1
  return m
}
function pad (s, n) { s = String(s); while (s.length < n) s += ' '; return s }

// =================================================================================================
// ENGINE FRONT-END — ported VERBATIM from web/recolour-engine.js (NOT the #53 spike; see [TRAP] in
// the header). These reproduce detectTextTiling's peak cloud byte-for-byte so the lattice-fit stage
// operates on the exact same peaks the shipped engine produces. Do not "improve" — fidelity is the
// point. Source line refs are to recolour-engine.js.
// =================================================================================================
var TEXT_TILING = { // engine:1103-1114
  WORK_MAX: 1024, NCC_CUTOFF: 0.5, EPS: 1e-10, MIN_PEAKS: 3, MIN_SCORE: 0.5,
  PITCH_TOL_MAG: 0.18, PITCH_TOL_DEG: 18, V1_MIN_DEG: 20, V1_MIN_SUPPORT: 2, MIN_TEMPLATE: 4
}
function clampRegion (region, width, height) { // engine:72-79
  if (!region) return { x0: 0, y0: 0, x1: width, y1: height }
  var x0 = Math.max(0, Math.min(width, Math.floor(region.x)))
  var y0 = Math.max(0, Math.min(height, Math.floor(region.y)))
  var x1 = Math.max(x0, Math.min(width, Math.floor(region.x + region.width)))
  var y1 = Math.max(y0, Math.min(height, Math.floor(region.y + region.height)))
  return { x0: x0, y0: y0, x1: x1, y1: y1 }
}
function canonicalBasis (lx, ly) { // engine:1085-1088
  if (lx > 0 || (lx === 0 && ly > 0)) return { x: lx, y: ly }
  return { x: -lx, y: -ly }
}
function po2Ceil (v) { var p = 1; while (p < v) p *= 2; return p } // engine:1117
function fft (re, im, inverse) { // engine:786-814
  var n = re.length
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { var tr = re[i]; re[i] = re[j]; re[j] = tr; var ti = im[i]; im[i] = im[j]; im[j] = ti }
  }
  for (var len = 2; len <= n; len <<= 1) {
    var ang = (inverse ? 2 : -2) * Math.PI / len
    var wr = Math.cos(ang), wi = Math.sin(ang)
    for (var s = 0; s < n; s += len) {
      var cwr = 1, cwi = 0, half = len >> 1
      for (var k = 0; k < half; k++) {
        var a = s + k, b = s + k + half
        var xr = re[b] * cwr - im[b] * cwi, xi = re[b] * cwi + im[b] * cwr
        re[b] = re[a] - xr; im[b] = im[a] - xi
        re[a] = re[a] + xr; im[a] = im[a] + xi
        var ncwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = ncwr
      }
    }
  }
}
function fft2 (re, im, inverse, N, lineRe, lineIm) { // engine:818-832
  var x, y
  for (y = 0; y < N; y++) {
    var off = y * N
    for (x = 0; x < N; x++) { lineRe[x] = re[off + x]; lineIm[x] = im[off + x] }
    fft(lineRe, lineIm, inverse)
    for (x = 0; x < N; x++) { re[off + x] = lineRe[x]; im[off + x] = lineIm[x] }
  }
  for (x = 0; x < N; x++) {
    for (y = 0; y < N; y++) { lineRe[y] = re[y * N + x]; lineIm[y] = im[y * N + x] }
    fft(lineRe, lineIm, inverse)
    for (y = 0; y < N; y++) { re[y * N + x] = lineRe[y]; im[y * N + x] = lineIm[y] }
  }
  if (inverse) { var s = 1 / (N * N); for (var i = 0; i < N * N; i++) { re[i] *= s; im[i] *= s } }
}
function fullLuma (imageData) { // engine:1121-1125
  var data = imageData.data, n = imageData.width * imageData.height, luma = new Float64Array(n)
  for (var i = 0; i < n; i++) { var o = i * 4; luma[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] }
  return luma
}
function downscaleToLuma (imageData, dw, dh) { // engine:1130-1148 (area-average — NOT the spike's resize)
  var data = imageData.data, W = imageData.width, H = imageData.height, out = new Float64Array(dw * dh)
  for (var y = 0; y < dh; y++) {
    var sy0 = Math.floor(y * H / dh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * H / dh))
    for (var x = 0; x < dw; x++) {
      var sx0 = Math.floor(x * W / dw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * W / dw))
      var sum = 0, cnt = 0
      for (var sy = sy0; sy < sy1 && sy < H; sy++) {
        var row = sy * W
        for (var sx = sx0; sx < sx1 && sx < W; sx++) {
          var o = (row + sx) * 4
          sum += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]; cnt++
        }
      }
      out[y * dw + x] = cnt ? sum / cnt : 0
    }
  }
  return out
}
function buildSAT (luma, W, H) { // engine:1152-1165
  var sat = new Float64Array((W + 1) * (H + 1)), sat2 = new Float64Array((W + 1) * (H + 1))
  for (var y = 0; y < H; y++) {
    var rowSum = 0, rowSum2 = 0
    for (var x = 0; x < W; x++) {
      var v = luma[y * W + x]
      rowSum += v; rowSum2 += v * v
      var idx = (y + 1) * (W + 1) + (x + 1)
      sat[idx] = sat[y * (W + 1) + (x + 1)] + rowSum
      sat2[idx] = sat2[y * (W + 1) + (x + 1)] + rowSum2
    }
  }
  return { sat: sat, sat2: sat2 }
}
function winSum (sat, W, u, v, tw, th) { // engine:1166-1169
  var s = W + 1
  return sat[(v + th) * s + (u + tw)] - sat[v * s + (u + tw)] - sat[(v + th) * s + u] + sat[v * s + u]
}
function fastNCC (luma, W, H, bbox) { // engine:1176-1224
  var tw = bbox.x1 - bbox.x0, th = bbox.y1 - bbox.y0
  var N = po2Ceil(Math.max(W, H))
  var lineRe = new Float64Array(N), lineIm = new Float64Array(N), ty, tx, k
  var meanT = 0
  for (ty = 0; ty < th; ty++) for (tx = 0; tx < tw; tx++) meanT += luma[(bbox.y0 + ty) * W + (bbox.x0 + tx)]
  meanT /= (tw * th)
  var tPad = new Float64Array(N * N), tIm = new Float64Array(N * N), energyT = 0
  for (ty = 0; ty < th; ty++) for (tx = 0; tx < tw; tx++) {
    var tv = luma[(bbox.y0 + ty) * W + (bbox.x0 + tx)] - meanT
    tPad[ty * N + tx] = tv; energyT += tv * tv
  }
  var iPad = new Float64Array(N * N), iIm = new Float64Array(N * N)
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) iPad[y * N + x] = luma[y * W + x]
  fft2(iPad, iIm, false, N, lineRe, lineIm)
  fft2(tPad, tIm, false, N, lineRe, lineIm)
  var cRe = new Float64Array(N * N), cIm = new Float64Array(N * N)
  for (k = 0; k < N * N; k++) {
    var a = iPad[k], b = iIm[k], c = tPad[k], dd = tIm[k]
    cRe[k] = a * c + b * dd; cIm[k] = b * c - a * dd
  }
  fft2(cRe, cIm, true, N, lineRe, lineIm)
  var S = buildSAT(luma, W, H)
  var ncc = new Float64Array(W * H)
  var n = tw * th, validW = W - tw, validH = H - th, sqrtET = Math.sqrt(energyT)
  for (var v = 0; v <= validH; v++) {
    for (var u = 0; u <= validW; u++) {
      var sum = winSum(S.sat, W, u, v, tw, th), sum2 = winSum(S.sat2, W, u, v, tw, th)
      var energyI = sum2 - (sum * sum) / n
      if (energyI < 0) energyI = 0
      var denom = Math.sqrt(energyI) * sqrtET
      if (denom < TEXT_TILING.EPS) denom = TEXT_TILING.EPS
      var val = cRe[v * N + u] / denom
      if (val > 1) val = 1; else if (val < -1) val = -1
      ncc[v * W + u] = val
    }
  }
  return { ncc: ncc, tw: tw, th: th, validW: validW, validH: validH, W: W }
}
function extractTextPeaks (res, cutoff) { // engine:1230-1253
  var W = res.W, ncc = res.ncc, tw = res.tw, th = res.th, cand = []
  for (var v = 1; v < res.validH; v++) {
    for (var u = 1; u < res.validW; u++) {
      var val = ncc[v * W + u]
      if (val < cutoff) continue
      if (val < ncc[v * W + u - 1] || val < ncc[v * W + u + 1] ||
          val < ncc[(v - 1) * W + u] || val < ncc[(v + 1) * W + u] ||
          val < ncc[(v - 1) * W + u - 1] || val < ncc[(v - 1) * W + u + 1] ||
          val < ncc[(v + 1) * W + u - 1] || val < ncc[(v + 1) * W + u + 1]) continue
      cand.push({ x: u + (tw >> 1), y: v + (th >> 1), v: val })
    }
  }
  cand.sort(function (a, b) { return b.v - a.v })
  var kept = []
  for (var i = 0; i < cand.length; i++) {
    var ok = true
    for (var j = 0; j < kept.length; j++) {
      if (Math.abs(cand[i].x - kept[j].x) < tw && Math.abs(cand[i].y - kept[j].y) < th) { ok = false; break }
    }
    if (ok) kept.push(cand[i])
  }
  return kept
}

// Reproduce detectTextTiling's front-end EXACTLY (engine:1297-1322) up to the peak cloud, returning
// the peaks in WORKING coords plus scale/template so the lattice-fit stage can rescale to full px.
function computePeaks (imageData, region) {
  var W = imageData.width, H = imageData.height
  var bb = clampRegion(region, W, H)
  if (bb.x1 - bb.x0 < TEXT_TILING.MIN_TEMPLATE || bb.y1 - bb.y0 < TEXT_TILING.MIN_TEMPLATE) return null
  var scale = Math.min(1, TEXT_TILING.WORK_MAX / Math.max(W, H))
  var dw = Math.max(1, Math.round(W * scale)), dh = Math.max(1, Math.round(H * scale))
  var work = scale < 1 ? downscaleToLuma(imageData, dw, dh) : fullLuma(imageData)
  var tbox = {
    x0: Math.max(0, Math.round(bb.x0 * scale)), y0: Math.max(0, Math.round(bb.y0 * scale)),
    x1: Math.min(dw, Math.round(bb.x1 * scale)), y1: Math.min(dh, Math.round(bb.y1 * scale))
  }
  if (tbox.x1 - tbox.x0 < TEXT_TILING.MIN_TEMPLATE || tbox.y1 - tbox.y0 < TEXT_TILING.MIN_TEMPLATE) return null
  var res = fastNCC(work, dw, dh, tbox)
  var peaks = extractTextPeaks(res, TEXT_TILING.NCC_CUTOFF)
  return { peaks: peaks, scale: scale, dw: dw, dh: dh, tbox: tbox, inv: scale < 1 ? 1 / scale : 1 }
}

// =================================================================================================
// STAGE 1 — GLOBAL LATTICE FIT (the #58 fix under test). Replaces detectTextTiling's seed-LOCAL NN
// v1 heuristic (engine:1324-1346) with a fit over the WHOLE peak cloud.
// =================================================================================================
function vdot (a, b) { return a.x * b.x + a.y * b.y }
function vmag (a) { return Math.hypot(a.x, a.y) }
function vcross (a, b) { return a.x * b.y - a.y * b.x }

// Supported lattice translation vectors from the FULL peak cloud (position-invariant — reads every
// peak pair, not the seed's neighbours). A primitive lattice vector recurs O(N) times across pairs;
// a spurious diff recurs ~once. Canonicalised to the +x half-plane and averaged within a `tol` bucket.
function supportedOffsets (peaks, tol) {
  var map = {}
  for (var i = 0; i < peaks.length; i++) {
    for (var j = 0; j < peaks.length; j++) {
      if (i === j) continue
      var dx = peaks[j].x - peaks[i].x, dy = peaks[j].y - peaks[i].y
      if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy } // canonical +x half-plane
      if (Math.hypot(dx, dy) < tol) continue // skip near-zero (self / NMS residue)
      var key = Math.round(dx / tol) + ',' + Math.round(dy / tol)
      if (!map[key]) map[key] = { x: 0, y: 0, n: 0 }
      map[key].x += dx; map[key].y += dy; map[key].n++
    }
  }
  var out = []
  for (var k in map) { var m = map[k]; out.push({ x: m.x / m.n, y: m.y / m.n, mag: Math.hypot(m.x / m.n, m.y / m.n), support: m.n }) }
  return out
}

// Lagrange-Gauss 2-D basis reduction: return the two SHORTEST independent vectors of the lattice
// generated by (b0,b1). Position-invariant. CAPPED at 20 iterations (near-collinear inputs can spin).
function gaussReduce (b0, b1) {
  b0 = { x: b0.x, y: b0.y }; b1 = { x: b1.x, y: b1.y }
  for (var it = 0; it < 20; it++) {
    if (vmag(b1) < vmag(b0)) { var t = b0; b0 = b1; b1 = t }
    var d0 = vdot(b0, b0); if (d0 === 0) break
    var m = Math.round(vdot(b0, b1) / d0)
    if (m === 0) break
    b1 = { x: b1.x - m * b0.x, y: b1.y - m * b0.y }
  }
  return [b0, b1]
}

// Deterministic subharmonic rejection (up front, not post-hoc). A non-overlapping tile period must be
// >= the seed footprint projected onto the vector's direction. If a reduced vector is shorter, the
// peak cloud held half-period matches (glyph sub-parts) — promote to the smallest integer multiple
// that clears the footprint. Returns {v, promoted:k}.
function rejectSubharmonic (v, fw, fh) {
  var mag = vmag(v); if (mag === 0) return { v: v, k: 1 }
  var ux = v.x / mag, uy = v.y / mag
  var extent = Math.abs(ux) * fw + Math.abs(uy) * fh
  if (mag >= extent) return { v: v, k: 1 }
  var k = Math.ceil(extent / mag)
  return { v: { x: v.x * k, y: v.y * k }, k: k }
}

// Least-squares phase refinement: index each peak to its nearest integer (i,j) under the integer
// basis, then solve peak ≈ origin + i·v0 + j·v1 for refined v0,v1,origin (normal equations on the
// 3-unknown-per-axis system). Returns refined basis + origin + max far-edge residual (drift).
function refinePhase (peaks, v0, v1, origin) {
  // Assign integer coords via the (possibly non-orthogonal) basis inverse.
  var det = v0.x * v1.y - v0.y * v1.x
  if (Math.abs(det) < 1e-9) return null
  var pts = []
  for (var p = 0; p < peaks.length; p++) {
    var rx = peaks[p].x - origin.x, ry = peaks[p].y - origin.y
    var i = Math.round((rx * v1.y - ry * v1.x) / det)
    var j = Math.round((-rx * v0.y + ry * v0.x) / det)
    pts.push({ i: i, j: j, x: peaks[p].x, y: peaks[p].y })
  }
  // Solve [ox oy v0 v1] via normal equations on model x = ox + i*v0x + j*v1x (and y analogously).
  // Design matrix columns: [1, i, j]; separate LSQ for x and y (shared geometry).
  var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0]
  for (var q = 0; q < pts.length; q++) {
    var f = [1, pts[q].i, pts[q].j]
    for (var r = 0; r < 3; r++) { for (var c = 0; c < 3; c++) A[r][c] += f[r] * f[c]; bx[r] += f[r] * pts[q].x; by[r] += f[r] * pts[q].y }
  }
  var sx = solve3(A, bx), sy = solve3(A, by)
  if (!sx || !sy) return null
  var rOrigin = { x: sx[0], y: sy[0] }, rv0 = { x: sx[1], y: sy[1] }, rv1 = { x: sx[2], y: sy[2] }
  // Max residual = far-edge drift.
  var maxRes = 0
  for (var s = 0; s < pts.length; s++) {
    var px = rOrigin.x + pts[s].i * rv0.x + pts[s].j * rv1.x
    var py = rOrigin.y + pts[s].i * rv0.y + pts[s].j * rv1.y
    var res = Math.hypot(px - pts[s].x, py - pts[s].y)
    if (res > maxRes) maxRes = res
  }
  return { origin: rOrigin, v0: rv0, v1: rv1, maxResidual: maxRes, pts: pts }
}
// Gaussian elimination for a 3x3 system.
function solve3 (A, b) {
  var M = [[A[0][0], A[0][1], A[0][2], b[0]], [A[1][0], A[1][1], A[1][2], b[1]], [A[2][0], A[2][1], A[2][2], b[2]]]
  for (var col = 0; col < 3; col++) {
    var piv = col
    for (var r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-12) return null
    var tmp = M[col]; M[col] = M[piv]; M[piv] = tmp
    for (var r2 = 0; r2 < 3; r2++) {
      if (r2 === col) continue
      var f = M[r2][col] / M[col][col]
      for (var c2 = col; c2 < 4; c2++) M[r2][c2] -= f * M[col][c2]
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]]
}

// Full fit: peaks (working coords) + template footprint (working px) -> basis in FULL-image px.
// Selection is DRIFT-DRIVEN (fit quality), not shortest-first: among supported non-collinear
// candidates for v1, pick the one whose reduced lattice best explains the peak cloud. A 2-D basis is
// accepted only if its integer drift clears DRIFT_TOL — otherwise fall back to the 1-D v0 lattice.
// This is the principled subharmonic/noise rejection: the GALE-style spurious (193,0) has ~30px drift
// and is rejected; the clean TAYLOR (415,0) has ~1px drift and is kept.
function globalLatticeFit (peaks, fw, fh, inv, opts) {
  opts = opts || {}
  var tol = opts.tol || 4
  var N = peaks.length
  var result = { tiling: false, basis: [], support: [], subPromoted: [], driftWork: null, N: N }
  if (N < TEXT_TILING.MIN_PEAKS) return result
  // Inlier filter: true repeats of the seed score high NCC; cross-matches (e.g. GALE weakly matching
  // parts of TAYLOR) score lower and inject subharmonic/noise offsets. Fit the lattice on the strong
  // peaks only. Keep >= MIN_PEAKS by relaxing the cut if needed. Coverage/drift still use ALL peaks.
  var fitPeaks = peaks
  if (opts.inlierCut != null) {
    var strong = peaks.filter(function (p) { return p.v >= opts.inlierCut })
    if (strong.length >= TEXT_TILING.MIN_PEAKS) fitPeaks = strong
  }
  var Nf = fitPeaks.length
  var minSup = Math.max(2, Math.round((opts.minSupportFrac != null ? opts.minSupportFrac : 0.15) * Nf))
  var offs = supportedOffsets(fitPeaks, tol).filter(function (o) { return o.support >= minSup && o.mag >= 2 })
  offs.sort(function (a, b) { return a.mag - b.mag })
  result.support = offs.slice(0, 8)
  if (!offs.length) return result
  // origin for drift = the strongest peak (the seed matches itself at NCC~1); drift is origin-agnostic
  // for a consistent lattice, but a real node anchors the integer indexing cleanly.
  var origin = fitPeaks[0]
  for (var oi = 1; oi < fitPeaks.length; oi++) if (fitPeaks[oi].v > origin.v) origin = fitPeaks[oi]
  var b0 = offs[0]
  var sinMin = Math.sin(TEXT_TILING.V1_MIN_DEG * Math.PI / 180)
  var driftTol = Math.max(opts.driftAbs || 6, (opts.driftFrac != null ? opts.driftFrac : 0.12) * b0.mag)
  // Best non-collinear v1 by MIN integer drift of the reduced basis.
  var best = null
  for (var i = 0; i < offs.length; i++) {
    if (Math.abs(vcross(b0, offs[i])) / (b0.mag * offs[i].mag) <= sinMin) continue // collinear
    var red = gaussReduce(b0, offs[i])
    var d = maxIntDrift(fitPeaks, red[0], red[1], origin)
    if (!best || d < best.d) best = { red: red, d: d }
  }
  var reduced, driftWork
  if (best && best.d <= driftTol) { reduced = best.red; driftWork = best.d } // accept 2-D
  else { reduced = [{ x: b0.x, y: b0.y }]; driftWork = maxIntDrift(fitPeaks, b0, null, origin) } // 1-D fallback
  result.driftWork = driftWork
  // Explained-fraction gate: a valid lattice must account for most INLIER peaks. A non-discriminative
  // sub-glyph seed (single letter) yields a dense cloud where a sparse lattice explains few peaks even
  // if a lucky subset looks locally clean — this is what let the letter-A 84-stamp slip past drift.
  var expTol = Math.max(6, 0.2 * Math.min(vmag(reduced[0]), reduced[1] ? vmag(reduced[1]) : Infinity))
  var explained = explainedFraction(fitPeaks, reduced[0], reduced[1] || null, origin, expTol)
  result.explainedFrac = explained
  if (explained < (opts.explainMin != null ? opts.explainMin : 0.6)) { // non-tiling / fragment seed
    result.tiling = false; result.basis = []; result.reason = 'low-explained-frac ' + explained.toFixed(2)
    return result
  }
  // Subharmonic rejection per vector (footprint in WORKING px).
  var promoted = []
  reduced = reduced.map(function (v) { var r = rejectSubharmonic(v, fw, fh); promoted.push(r.k); return r.v })
  result.subPromoted = promoted
  // Rescale working -> full-image px, canonicalise (mirror engine).
  result.basis = reduced.map(function (v) { return canonicalBasis(Math.round(v.x * inv), Math.round(v.y * inv)) })
  result.tiling = true
  result.reducedWork = reduced
  return result
}

// Systematic sweep: box a fixed-size template at a grid of top-left positions and flag any that
// fire a 2-D basis (basisN=2) or an anomalous stamp count — those are the 76-style over-stamps.
function sweep (img, tw, th, step) {
  console.log('\n=== SWEEP: template ' + tw + 'x' + th + ', step ' + step + ' — flagging basisN=2 / stamped>10 ===')
  var flagged = []
  for (var y = 10; y + th < img.height - 10; y += step) {
    for (var x = 10; x + tw < img.width - 10; x += step) {
      var s = { x: x, y: y, width: tw, height: th }
      var r = Engine.detectTextTiling(img, s)
      if (!r.tiling) continue
      var seedMask = boxMask(img.width, img.height, s)
      var prop = Engine.propagateMask(seedMask, img.width, img.height, r.tileBasis)
      if (r.tileBasis.length === 2 || prop.instances > 10) {
        flagged.push({ x: x, y: y, basisN: r.tileBasis.length, basis: r.tileBasis, stamped: prop.instances, sub: prop.subharmonicWarning, rows: prop.rows, cols: prop.cols })
      }
    }
  }
  flagged.sort(function (a, b) { return b.stamped - a.stamped })
  flagged.slice(0, 25).forEach(function (f) {
    var b = f.basis.map(function (v) { return '(' + v.x + ',' + v.y + ')' }).join(' ')
    console.log('  (' + pad(f.x + ',' + f.y, 8) + ') basisN=' + f.basisN + ' basis=' + b +
      ' stamped=' + f.stamped + ' (' + f.rows + 'r x ' + f.cols + 'c)' + (f.sub ? ' SUBHARM' : ''))
  })
  console.log('  total flagged: ' + flagged.length)
  return flagged
}

// M1 node coverage: from origin (a real peak), enumerate lattice nodes; a node "lands on real letter
// energy" if an actual peak sits within `tol`. In-frame nodes with no peak are candidate occluded/
// missed; off-frame nodes are legitimate clipped extrapolations. Also reports peaks NOT explained by
// any node (lattice precision). All in WORKING coords.
function nodeCoverage (peaks, v0, v1, origin, W, H, tol) {
  var nodes = [], hit = 0, inframeMiss = 0
  var diag = W + H
  var iMax = Math.ceil(diag / vmag(v0)) + 1
  var jMax = v1 ? Math.ceil(diag / vmag(v1)) + 1 : 0
  var peakHitByNode = new Array(peaks.length)
  for (var i = -iMax; i <= iMax; i++) {
    for (var j = -jMax; j <= jMax; j++) {
      var nx = origin.x + i * v0.x + (v1 ? j * v1.x : 0)
      var ny = origin.y + i * v0.y + (v1 ? j * v1.y : 0)
      var inFrame = nx >= -tol && nx < W + tol && ny >= -tol && ny < H + tol
      // nearest peak
      var best = Infinity, bk = -1
      for (var p = 0; p < peaks.length; p++) {
        var d = Math.hypot(peaks[p].x - nx, peaks[p].y - ny)
        if (d < best) { best = d; bk = p }
      }
      if (inFrame) {
        nodes.push({ x: nx, y: ny })
        if (best <= tol) { hit++; peakHitByNode[bk] = true } else inframeMiss++
      }
    }
  }
  var unexplained = 0
  for (var q = 0; q < peaks.length; q++) if (!peakHitByNode[q]) unexplained++
  return { inFrameNodes: nodes.length, hit: hit, inframeMiss: inframeMiss, unexplainedPeaks: unexplained, nodes: nodes }
}

// Fraction of peaks lying within `tol` of an integer lattice node. A discriminative tile explains
// ~all its (inlier) peaks; a sub-glyph fragment leaves most unexplained.
function explainedFraction (peaks, v0, v1, origin, tol) {
  if (!peaks.length) return 0
  var det = v1 ? (v0.x * v1.y - v0.y * v1.x) : 0, ok = 0
  for (var p = 0; p < peaks.length; p++) {
    var rx = peaks[p].x - origin.x, ry = peaks[p].y - origin.y, nx, ny
    if (v1 && Math.abs(det) > 1e-9) {
      var i = Math.round((rx * v1.y - ry * v1.x) / det), j = Math.round((-rx * v0.y + ry * v0.x) / det)
      nx = origin.x + i * v0.x + j * v1.x; ny = origin.y + i * v0.y + j * v1.y
    } else {
      var t = Math.round((rx * v0.x + ry * v0.y) / (v0.x * v0.x + v0.y * v0.y))
      nx = origin.x + t * v0.x; ny = origin.y + t * v0.y
    }
    if (Math.hypot(peaks[p].x - nx, peaks[p].y - ny) <= tol) ok++
  }
  return ok / peaks.length
}

// Max residual of each peak to its nearest INTEGER lattice node (before LSQ refinement) — the M3
// baseline that phase refinement must not mask a bad basis behind.
function maxIntDrift (peaks, v0, v1, origin) {
  var det = v1 ? (v0.x * v1.y - v0.y * v1.x) : 0
  var maxR = 0
  for (var p = 0; p < peaks.length; p++) {
    var rx = peaks[p].x - origin.x, ry = peaks[p].y - origin.y, nx, ny
    if (v1 && Math.abs(det) > 1e-9) {
      var i = Math.round((rx * v1.y - ry * v1.x) / det), j = Math.round((-rx * v0.y + ry * v0.x) / det)
      nx = origin.x + i * v0.x + j * v1.x; ny = origin.y + i * v0.y + j * v1.y
    } else {
      var t = Math.round((rx * v0.x + ry * v0.y) / (v0.x * v0.x + v0.y * v0.y))
      nx = origin.x + t * v0.x; ny = origin.y + t * v0.y
    }
    var r = Math.hypot(peaks[p].x - nx, peaks[p].y - ny)
    if (r > maxR) maxR = r
  }
  return maxR
}

// One seed through the full fit + metrics. Returns a record for cohort/determinism analysis.
function fitSeed (img, s) {
  var pk = computePeaks(img, s)
  if (!pk) return { label: s.label, tile: s.tile, skipped: true }
  var fw = pk.tbox.x1 - pk.tbox.x0, fh = pk.tbox.y1 - pk.tbox.y0
  var fit = globalLatticeFit(pk.peaks, fw, fh, pk.inv, { inlierCut: 0.65 })
  var seedMask = boxMask(img.width, img.height, s)
  var prop = Engine.propagateMask(seedMask, img.width, img.height, fit.basis)
  var cov = null, driftInt = null, driftRef = null, origin = null
  if (fit.reducedWork) {
    var scx = (s.x + s.width / 2) * pk.scale, scy = (s.y + s.height / 2) * pk.scale
    var ob = Infinity; origin = { x: scx, y: scy }
    for (var pp = 0; pp < pk.peaks.length; pp++) { var dd = Math.hypot(pk.peaks[pp].x - scx, pk.peaks[pp].y - scy); if (dd < ob) { ob = dd; origin = pk.peaks[pp] } }
    var rw0 = fit.reducedWork[0], rw1 = fit.reducedWork[1] || null
    cov = nodeCoverage(pk.peaks, rw0, rw1, origin, pk.dw, pk.dh, Math.max(6, fw * 0.25))
    driftInt = maxIntDrift(pk.peaks, rw0, rw1, origin) // BEFORE refinement (devil's-advocate ordering)
    if (rw1) { var rp = refinePhase(pk.peaks, rw0, rw1, origin); if (rp) driftRef = rp.maxResidual }
  }
  return {
    label: s.label, tile: s.tile, seed: s, pk: pk, fit: fit, prop: prop, cov: cov,
    driftInt: driftInt, driftRef: driftRef, origin: origin,
    sig: fit.basis.map(function (v) { return v.x + ',' + v.y }).sort().join(' | ')
  }
}

function printFit (r) {
  if (r.skipped) { console.log(pad(r.label, 22) + ' <sub-template>'); return }
  var bstr = r.fit.basis.map(function (v) { return '(' + v.x + ',' + v.y + ')' }).join(' ')
  console.log(
    pad(r.label, 22) + ' peaks=' + r.pk.peaks.length +
    ' basisN=' + r.fit.basis.length + ' basis=' + (bstr || '-') +
    (r.fit.reason ? ' [' + r.fit.reason + ']' : '') +
    ' explFrac=' + (r.fit.explainedFrac != null ? r.fit.explainedFrac.toFixed(2) : '-') +
    ' | stamped=' + r.prop.instances + ' (' + r.prop.rows + 'r x ' + r.prop.cols + 'c)' +
    (r.prop.subharmonicWarning ? ' SUBHARM' : '') +
    (r.cov ? ' | M1 ' + r.cov.hit + '/' + r.cov.inFrameNodes + ' hit ' + r.cov.inframeMiss + ' miss ' + r.cov.unexplainedPeaks + ' unexpl' : '') +
    (r.driftInt != null ? ' | M3 int=' + r.driftInt.toFixed(2) + (r.driftRef != null ? ' ref=' + r.driftRef.toFixed(2) : '') + 'px' : '')
  )
}

// STAGE 1: fit every seed; report M1/M3 per seed and M2 determinism GROUPED BY TILE COHORT (same
// glyph boxed at different positions must agree — the 6-vs-76 invariant).
function runStage1 (img, seeds) {
  console.log('\n=== STAGE 1: GLOBAL lattice fit (the #58 fix) ===')
  var results = seeds.map(function (s) { var r = fitSeed(img, s); printFit(r); return r })
  console.log('\n  M2 DETERMINISM — distinct fitted bases WITHIN each tile cohort (must be 1):')
  var cohorts = {}
  results.forEach(function (r) { if (r.skipped) return; (cohorts[r.tile] = cohorts[r.tile] || []).push(r) })
  var m2pass = true
  Object.keys(cohorts).forEach(function (t) {
    var grp = cohorts[t], sigs = {}
    grp.forEach(function (r) { sigs[r.sig] = (sigs[r.sig] || 0) + 1 })
    var n = Object.keys(sigs).length
    var tiling = grp.filter(function (r) { return r.fit.tiling })
    console.log('    ' + pad(t, 16) + ' ' + grp.length + ' seeds, ' + tiling.length + ' tiling, distinct bases=' + n +
      '  ' + Object.keys(sigs).map(function (k) { return '[' + sigs[k] + 'x](' + (k || 'reject') + ')' }).join(' '))
    // A cohort of VALID instances (marked wantTiling) must be deterministic (1 basis) AND tile.
    if (grp[0].seed.wantTiling && (n > 1 || tiling.length !== grp.length)) m2pass = false
  })
  return { results: results, m2pass: m2pass }
}

// M4 negative controls: box a plausible instance on non-tiling images. A FALSE POSITIVE = a confident
// 2-D lattice (basisN===2 AND explainedFrac high). Per WORKFLOW-16 a false positive is the ONLY
// NO-GO trigger. 1-D fallbacks / tiling:false are clean.
function runNegatives (imgs) {
  console.log('\n=== M4 NEGATIVE CONTROLS (a confident 2-D lattice here = false positive = NO-GO) ===')
  var falsePos = []
  imgs.forEach(function (o) {
    var pk = computePeaks(o.img, o.box)
    if (!pk) { console.log(pad(o.name, 26) + ' <sub-template>'); return }
    var fw = pk.tbox.x1 - pk.tbox.x0, fh = pk.tbox.y1 - pk.tbox.y0
    var fit = globalLatticeFit(pk.peaks, fw, fh, pk.inv, { inlierCut: 0.65 })
    var confident2D = fit.tiling && fit.basis.length === 2 && fit.explainedFrac >= 0.6
    console.log(pad(o.name, 26) + ' peaks=' + pk.peaks.length + ' tiling=' + fit.tiling +
      ' basisN=' + fit.basis.length + ' explFrac=' + (fit.explainedFrac != null ? fit.explainedFrac.toFixed(2) : '-') +
      (fit.reason ? ' [' + fit.reason + ']' : '') + (confident2D ? '  <<< FALSE POSITIVE' : '  ok'))
    if (confident2D) falsePos.push(o.name)
  })
  return falsePos
}

// M5 (diagnostic, NOT a gate): the peak-cloud AUTOCORRELATION == the difference-vector histogram
// (supportedOffsets). Render it as a centred heat PNG; the true period is the first off-centre
// cluster, a subharmonic would appear as a cluster at HALF that distance. Also prints the top offsets.
function writeM5 (peaks, tag) {
  var offs = supportedOffsets(peaks, 4).sort(function (a, b) { return b.support - a.support })
  console.log('\n  M5 peak-cloud autocorrelation — top difference-vector offsets (support desc):')
  offs.slice(0, 8).forEach(function (o) {
    console.log('    (' + pad(Math.round(o.x) + ',' + Math.round(o.y), 9) + ') |v|=' + o.mag.toFixed(1) + ' support=' + o.support)
  })
  // Render centred: canvas 2R x 2R, brightness ∝ support (log). Mirror to the -x half-plane.
  var R = 260, C = new Jimp(2 * R, 2 * R, 0xff)
  for (var i = 0; i < C.bitmap.data.length; i += 4) { C.bitmap.data[i] = C.bitmap.data[i + 1] = C.bitmap.data[i + 2] = 20; C.bitmap.data[i + 3] = 255 }
  var maxSup = offs.reduce(function (m, o) { return Math.max(m, o.support) }, 1)
  offs.forEach(function (o) {
    var g = Math.round(255 * Math.log(1 + o.support) / Math.log(1 + maxSup))
    plotDot(C, R + o.x, R + o.y, g); plotDot(C, R - o.x, R - o.y, g)
  })
  plotDot(C, R, R, 255, [255, 60, 60]) // origin marker
  var f = path.join(OUT, 'm5-autocorr-' + tag + '.png')
  return C.writeAsync(f).then(function () { console.log('    wrote ' + path.relative(process.cwd(), f)) })
}
function plotDot (im, x, y, g, rgb) {
  x = Math.round(x); y = Math.round(y)
  for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
    var px = x + dx, py = y + dy
    if (px < 0 || py < 0 || px >= im.bitmap.width || py >= im.bitmap.height) continue
    var o = (py * im.bitmap.width + px) * 4
    im.bitmap.data[o] = rgb ? rgb[0] : g; im.bitmap.data[o + 1] = rgb ? rgb[1] : g; im.bitmap.data[o + 2] = rgb ? rgb[2] : g; im.bitmap.data[o + 3] = 255
  }
}

// Lattice-overlay PNG: grayscale base + detected peaks (red) + predicted lattice nodes (green).
function writeLatticeOverlay (img, r, tag) {
  var W = img.width, H = img.height, im = new Jimp(W, H)
  var lum = fullLuma(img)
  for (var i = 0; i < W * H; i++) { var g = Math.min(255, Math.round(lum[i])), o = i * 4; im.bitmap.data[o] = g; im.bitmap.data[o + 1] = g; im.bitmap.data[o + 2] = g; im.bitmap.data[o + 3] = 255 }
  // predicted nodes (green) in FULL px
  if (r.fit.basis.length && r.origin) {
    var v0 = r.fit.basis[0], v1 = r.fit.basis[1] || null
    var ofx = r.origin.x * r.pk.inv, ofy = r.origin.y * r.pk.inv
    var iMax = Math.ceil((W + H) / vmag(v0)) + 1, jMax = v1 ? Math.ceil((W + H) / vmag(v1)) + 1 : 0
    for (var a = -iMax; a <= iMax; a++) for (var b = -jMax; b <= jMax; b++) {
      var nx = ofx + a * v0.x + (v1 ? b * v1.x : 0), ny = ofy + a * v0.y + (v1 ? b * v1.y : 0)
      if (nx < -20 || ny < -20 || nx > W + 20 || ny > H + 20) continue
      plotDot(im, nx, ny, 0, [40, 240, 40])
    }
  }
  // detected peaks (red) rescaled to full px
  r.pk.peaks.forEach(function (p) { plotDot(im, p.x * r.pk.inv, p.y * r.pk.inv, 0, [255, 40, 40]) })
  var f = path.join(OUT, 'lattice-' + tag + '.png')
  return im.writeAsync(f).then(function () { console.log('  wrote ' + path.relative(process.cwd(), f)) })
}

// ---- results.txt capture (tee console.log) ----------------------------------------------------
var LOG = []
var _log = console.log
console.log = function () { var s = Array.prototype.slice.call(arguments).join(' '); LOG.push(s); _log(s) }

// ---- main -------------------------------------------------------------------------------------
var DO_SWEEP = process.argv.indexOf('--sweep') >= 0
loadImageData('repeated-tile-template.jpg').then(function (img) {
  console.log('SPIKE #58 — position-invariant 2-D lattice fit for detectTextTiling')
  console.log('fixture repeated-tile-template.jpg ' + img.width + 'x' + img.height + '\n')
  // Seeds tagged by TILE cohort. wantTiling = a VALID user instance box (must be deterministic + tile).
  var seeds = [
    { label: 'r1 mid TAYLOR', x: 330, y: 32, width: 150, height: 46, tile: 'TAYLOR', wantTiling: true },
    { label: 'r3 mid TAYLOR', x: 330, y: 268, width: 150, height: 46, tile: 'TAYLOR', wantTiling: true },
    { label: 'r5 mid TAYLOR', x: 330, y: 490, width: 150, height: 46, tile: 'TAYLOR', wantTiling: true },
    { label: 'r1 mid GALE', x: 500, y: 32, width: 110, height: 46, tile: 'GALE', wantTiling: true },
    { label: 'r2 left GALE', x: 60, y: 150, width: 110, height: 46, tile: 'GALE', wantTiling: true },
    { label: 'r1 TAYLOR GALE', x: 300, y: 30, width: 320, height: 50, tile: 'PHRASE', wantTiling: false },
    // Sub-word / fragment boxes — NOT valid instances. The current engine over-stamps these (STAGE 0):
    // LOR slice -> 60, letter L -> 30. The fit must NOT reproduce those over-stamps.
    { label: 'r1 LOR slice', x: 372, y: 32, width: 70, height: 46, tile: 'FRAG', wantTiling: false },
    { label: 'r1 letter O', x: 388, y: 32, width: 34, height: 46, tile: 'FRAG', wantTiling: false }
  ]
  probeSeeds(img, seeds)
  var st1 = runStage1(img, seeds)

  // Negative controls (M4).
  return Promise.all([loadImageData('kids1.jpg'), loadImageData('watermark.jpg'), loadImageData('copyright-watermark.png')])
    .then(function (negs) {
      var falsePos = runNegatives([
        { name: 'kids1.jpg (photo)', img: negs[0], box: { x: (negs[0].width / 2 - 90) | 0, y: (negs[0].height / 2 - 30) | 0, width: 180, height: 60 } },
        { name: 'watermark.jpg (single)', img: negs[1], box: { x: (negs[1].width / 2 - 90) | 0, y: (negs[1].height / 2 - 30) | 0, width: 180, height: 60 } },
        { name: 'copyright-watermark.png', img: negs[2], box: { x: (negs[2].width / 2 - 90) | 0, y: (negs[2].height / 2 - 30) | 0, width: 180, height: 60 } }
      ])

      // Evidence for the canonical deterministic case (r1 mid TAYLOR).
      var canon = st1.results[0]
      writeM5(canon.pk.peaks, 'taylor')
      return writeLatticeOverlay(img, canon, 'taylor').then(function () {
        // ---- VERDICT (WORKFLOW-16: reject ONLY on M2 non-determinism or an M4 false positive) ----
        var GO = st1.m2pass && falsePos.length === 0
        console.log('\n================= GO / NO-GO =================')
        console.log('M2 per-cohort determinism (TAYLOR & GALE): ' + (st1.m2pass ? 'PASS' : 'FAIL'))
        console.log('M4 negative controls false positives: ' + (falsePos.length ? falsePos.join(', ') : 'none'))
        console.log('VERDICT: ' + (GO ? 'GO' : 'NO-GO'))
        console.log('=============================================')
        fs.writeFileSync(path.join(OUT, 'results.txt'), LOG.join('\n') + '\n')
        _log('\nwrote ' + path.relative(process.cwd(), path.join(OUT, 'results.txt')))
        if (DO_SWEEP) { sweep(img, 150, 46, 20); sweep(img, 110, 46, 20) }
      })
    })
}).catch(function (e) { console.error(e); process.exit(1) })
