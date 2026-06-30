#!/usr/bin/env node
/*
 * SPIKE (throwaway) — text-watermark detection via normalised cross-correlation (#53, T29 follow-up).
 *
 *   node scripts/spike-text-tiling.js
 *
 * WHY THIS SPIKE EXISTS
 * ---------------------
 * The shipped tile-fill flow (#47/#52) gets its lattice basis from detectTiling()'s FFT
 * autocorrelation comb. That comb needs MANY tile repeats inside its analysis window, so when
 * runTile() calls detectTiling({ region }) on the user's ONE-instance seed box there is no
 * periodicity, combCount<5, tileBasis=[], and propagateMask returns just the seed ("Found 1
 * instance · Not detected"). Even whole-image, sparse/irregular text marks can miss the comb.
 *
 * The missing signal is the repeated GLYPH SHAPE, and the user already hands us a template (the
 * boxed instance). This spike tests ONE question and builds nothing in web/ or src/:
 *
 *   Does FFT-based NORMALISED CROSS-CORRELATION of the user's seed template against the whole
 *   image recover >=3 watermark instances on real text-tiled fixtures, while staying quiet (no
 *   confident repeated lattice) on clean photos and on a single (non-tiled) watermark?
 *
 * METHOD (classic Lewis-1995 fast normalised cross-correlation):
 *   1. Crop a seed template T from the image (hand-set bbox per fixture, dumped as *-seed.png so it
 *      is self-verifying — the GUI gets this from detectWatermark(region).mask).
 *   2. numerator(u,v)   = cross-correlation of the image luma with the ZERO-MEAN template, computed
 *                         in O(N^2 log N) via the correlation theorem on the engine's radix-2 FFT:
 *                         IFFT( FFT(I) . conj(FFT(T'_padded)) ).
 *   3. denominator(u,v) = sqrt( windowEnergy_I(u,v) * energy_T ), windowEnergy via summed-area
 *                         tables (integral images) of I and I^2. The LOCAL-NORMALISATION WINDOW is
 *                         the template footprint itself (tw x th) — in fast-NCC this is NOT a free
 *                         knob (that is the #49 LCN-window trap removed by construction; recorded W
 *                         in the verdict is the template size).
 *   4. NCC(u,v)         = numerator / max(denominator, EPS).  EPS=1e-10 guards a flat/near-zero
 *                         variance template/region from returning NaN everywhere (known NCC killer).
 *   5. Peaks            = local maxima of NCC above a cutoff, non-max-suppressed with radius
 *                         >= max(tw,th) so the seed's own peak (NCC~1) cannot fragment into several
 *                         counted instances.
 *   6. Lattice          = >=3 peaks whose nearest-neighbour offsets cluster on a consistent pitch.
 *
 * GO/NO-GO GATE (WORKFLOW-16): rejection is keyed on FALSE POSITIVES on the negative controls
 * (clean photos + the single non-tiled watermark), NOT on positive-control strength. GO if the
 * tiled-text targets reach a >=3-instance consistent-pitch lattice AND no negative control does.
 *
 * Not part of `npm test`; touches nothing in web/ or src/. Durable evidence (PNGs + results.txt)
 * lands in scripts/evidence/spike-text-ncc/ so the go/no-go can cite it. The GO/NO-GO verdict,
 * chosen NCC cutoff, NMS radius and normalisation window W are printed at the end and saved.
 */
'use strict'

var fs = require('fs')
var path = require('path')
var _Jimp = require('jimp')
var Jimp = _Jimp.default || _Jimp // CORE-1: CJS vs ESM

// The 4K/8K negative-control photo blows jpeg-js's default memory cap. Raise it (decode-time only,
// throwaway harness, WORKFLOW-15). Never touches web/ or production paths.
var jpegjs = require('jpeg-js')
Jimp.decoders['image/jpeg'] = function (data) {
  return jpegjs.decode(data, { maxMemoryUsageInMB: 2048, maxResolutionInMP: 600 })
}

var FIX = path.join(__dirname, '..', 'test', 'files')
var OUT = path.join(__dirname, 'evidence', 'spike-text-ncc')

// ---- tunables (reported in the verdict) ------------------------------------------------------
var WORK_MAX = 1024     // downscale the longest side to <= this before NCC (keeps the 2D FFT cheap
                        // and is plenty of resolution for watermark glyph matching)
var EPS = 1e-10         // denominator floor — guards a flat template/region from NaN (NCC killer)
var NCC_CUTOFFS = [0.4, 0.5, 0.6, 0.7] // report instance counts across cutoffs to see target/control
                        // separation; the verdict recommends the cleanest separating cutoff.
var PITCH_TOL_MAG = 0.18 // a NN offset counts toward the dominant pitch if its magnitude is within
var PITCH_TOL_DEG = 18   // this fraction AND its direction within this many degrees of the median NN.
var LATTICE_MIN_PEAKS = 3 // DoD: a "detected tiling" needs at least this many instances...
var LATTICE_MIN_SCORE = 0.5 // ...and at least this fraction of peaks sharing the dominant pitch.

// ---- 1D radix-2 iterative FFT (in place); inverse = conjugate-twiddle, caller divides by n ------
// Ported verbatim from web/recolour-engine.js (reuse, do not reinvent).
function fft (re, im, inverse) {
  var n = re.length
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      var tr = re[i]; re[i] = re[j]; re[j] = tr
      var ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (var len = 2; len <= n; len <<= 1) {
    var ang = (inverse ? 2 : -2) * Math.PI / len
    var wr = Math.cos(ang), wi = Math.sin(ang)
    for (var s = 0; s < n; s += len) {
      var cwr = 1, cwi = 0, half = len >> 1
      for (var k = 0; k < half; k++) {
        var a = s + k, b = s + k + half
        var xr = re[b] * cwr - im[b] * cwi
        var xi = re[b] * cwi + im[b] * cwr
        re[b] = re[a] - xr; im[b] = im[a] - xi
        re[a] = re[a] + xr; im[a] = im[a] + xi
        var ncwr = cwr * wr - cwi * wi
        cwi = cwr * wi + cwi * wr
        cwr = ncwr
      }
    }
  }
}

// 2D FFT over NxN planes (engine fft2, with N passed in). Inverse divides by N*N.
function fft2 (re, im, inverse, N, lineRe, lineIm) {
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

function po2Ceil (v) { var p = 1; while (p < v) p *= 2; return p }

// ---- decode + downscale to luma --------------------------------------------------------------
function load (file) {
  return Jimp.read(path.join(FIX, file)).then(function (im) {
    var W = im.bitmap.width, H = im.bitmap.height
    var scale = Math.min(1, WORK_MAX / Math.max(W, H))
    if (scale < 1) { im = im.resize(Math.round(W * scale), Math.round(H * scale)); W = im.bitmap.width; H = im.bitmap.height }
    var luma = new Float64Array(W * H), d = im.bitmap.data
    for (var i = 0; i < W * H; i++) {
      var o = i * 4
      luma[i] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]
    }
    return { luma: luma, width: W, height: H, scale: scale }
  })
}

// ---- summed-area tables for the local image energy denominator -------------------------------
// sat[(y+1)*(W+1)+(x+1)] = sum of luma over [0..x] x [0..y]. Same shape for luma^2.
function buildSAT (luma, W, H) {
  var sat = new Float64Array((W + 1) * (H + 1))
  var sat2 = new Float64Array((W + 1) * (H + 1))
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
// Sum over the tw x th window with top-left at (u,v).
function winSum (sat, W, u, v, tw, th) {
  var s = W + 1
  return sat[(v + th) * s + (u + tw)] - sat[v * s + (u + tw)] - sat[(v + th) * s + u] + sat[v * s + u]
}

// ---- fast normalised cross-correlation -------------------------------------------------------
// Returns { ncc:Float64Array(W*H), tw, th, validW, validH } — NCC defined for top-left (u,v) in
// [0,W-tw] x [0,H-th]; elsewhere 0.
function fastNCC (img, bbox) {
  var W = img.width, H = img.height, luma = img.luma
  var tw = bbox.x1 - bbox.x0, th = bbox.y1 - bbox.y0
  var N = po2Ceil(Math.max(W, H))
  var lineRe = new Float64Array(N), lineIm = new Float64Array(N)

  // Zero-mean template + its energy.
  var meanT = 0, k
  for (var ty = 0; ty < th; ty++) for (var tx = 0; tx < tw; tx++) meanT += luma[(bbox.y0 + ty) * W + (bbox.x0 + tx)]
  meanT /= (tw * th)
  var tPad = new Float64Array(N * N), tIm = new Float64Array(N * N), energyT = 0
  for (ty = 0; ty < th; ty++) {
    for (tx = 0; tx < tw; tx++) {
      var tv = luma[(bbox.y0 + ty) * W + (bbox.x0 + tx)] - meanT
      tPad[ty * N + tx] = tv
      energyT += tv * tv
    }
  }

  // Image plane (zero-padded into NxN top-left).
  var iPad = new Float64Array(N * N), iIm = new Float64Array(N * N)
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) iPad[y * N + x] = luma[y * W + x]

  // Cross-correlation numerator = IFFT( FFT(I) . conj(FFT(T')) ).  c(u,v) = sum I(u+x,v+y) T'(x,y).
  fft2(iPad, iIm, false, N, lineRe, lineIm)
  fft2(tPad, tIm, false, N, lineRe, lineIm)
  var cRe = new Float64Array(N * N), cIm = new Float64Array(N * N)
  for (k = 0; k < N * N; k++) {
    // I * conj(T): (a+bi)(c-di) = (ac+bd) + (bc-ad)i
    var a = iPad[k], b = iIm[k], c = tPad[k], dd = tIm[k]
    cRe[k] = a * c + b * dd
    cIm[k] = b * c - a * dd
  }
  fft2(cRe, cIm, true, N, lineRe, lineIm) // cRe[v*N+u] = numerator(u,v)

  // Denominator via SAT; assemble NCC over the valid region.
  var S = buildSAT(luma, W, H)
  var ncc = new Float64Array(W * H)
  var n = tw * th
  var validW = W - tw, validH = H - th
  var sqrtET = Math.sqrt(energyT)
  for (var v = 0; v <= validH; v++) {
    for (var u = 0; u <= validW; u++) {
      var sum = winSum(S.sat, W, u, v, tw, th)
      var sum2 = winSum(S.sat2, W, u, v, tw, th)
      var energyI = sum2 - (sum * sum) / n // sum of squared deviations in the window
      if (energyI < 0) energyI = 0
      var denom = Math.sqrt(energyI) * sqrtET
      if (denom < EPS) denom = EPS // flat region/template guard (no NaN)
      var val = cRe[v * N + u] / denom
      if (val > 1) val = 1; else if (val < -1) val = -1
      ncc[v * W + u] = val
    }
  }
  return { ncc: ncc, tw: tw, th: th, validW: validW, validH: validH, W: W, H: H }
}

// ---- peak extraction (threshold + greedy NMS, ANISOTROPIC radius tw x th) ---------------------
// NMS must suppress within the template's own footprint on EACH axis independently (dx<tw AND
// dy<th), not a single isotropic radius = max(tw,th). A wide-but-short template (text watermarks
// are almost always wide-short) with an isotropic radius over-suppresses in the SHORT axis —
// confirmed empirically on TAYLOR GALE: tw=180,th=48 with isotropic r=180 collapsed 5 text ROWS
// (true vertical pitch ~113px, well inside r=180) down to 2 peaks; switching to anisotropic
// (dx<tw, dy<th) recovered all 12 true instances at cutoff 0.4. The seed's own peak still cannot
// fragment under this scheme because the peak's own footprint is exactly tw x th.
function extractPeaks (res, cutoff) {
  var W = res.W, ncc = res.ncc, tw = res.tw, th = res.th
  var cand = []
  for (var v = 1; v < res.validH; v++) {
    for (var u = 1; u < res.validW; u++) {
      var val = ncc[v * W + u]
      if (val < cutoff) continue
      // 3x3 local maximum
      if (val < ncc[v * W + u - 1] || val < ncc[v * W + u + 1] ||
          val < ncc[(v - 1) * W + u] || val < ncc[(v + 1) * W + u] ||
          val < ncc[(v - 1) * W + u - 1] || val < ncc[(v - 1) * W + u + 1] ||
          val < ncc[(v + 1) * W + u - 1] || val < ncc[(v + 1) * W + u + 1]) continue
      cand.push({ x: u + (tw >> 1), y: v + (th >> 1), v: val }) // store peak at template CENTRE
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
  return { peaks: kept, nmsTw: tw, nmsTh: th }
}

// ---- lattice / pitch consistency -------------------------------------------------------------
// Nearest-neighbour offset per peak (canonicalised to the +x half-plane), then the dominant pitch
// = median NN vector, and a score = fraction of NN vectors within tolerance of it.
function latticeScore (peaks) {
  if (peaks.length < 2) return { score: 0, pitch: null, nn: [] }
  var nn = []
  for (var i = 0; i < peaks.length; i++) {
    var best = Infinity, bx = 0, by = 0
    for (var j = 0; j < peaks.length; j++) {
      if (i === j) continue
      var dx = peaks[j].x - peaks[i].x, dy = peaks[j].y - peaks[i].y
      var d = dx * dx + dy * dy
      if (d < best) { best = d; bx = dx; by = dy }
    }
    if (bx < 0 || (bx === 0 && by < 0)) { bx = -bx; by = -by } // canonical +x half-plane
    nn.push({ x: bx, y: by, mag: Math.hypot(bx, by) })
  }
  // Median NN vector (by magnitude order, take the middle one's components).
  var byMag = nn.slice().sort(function (a, b) { return a.mag - b.mag })
  var med = byMag[byMag.length >> 1]
  var medAng = Math.atan2(med.y, med.x)
  var within = 0
  for (var p = 0; p < nn.length; p++) {
    var dm = Math.abs(nn[p].mag - med.mag) / (med.mag || 1)
    var da = Math.abs(Math.atan2(nn[p].y, nn[p].x) - medAng) * 180 / Math.PI
    if (da > 180) da = 360 - da
    if (dm <= PITCH_TOL_MAG && da <= PITCH_TOL_DEG) within++
  }
  return { score: within / nn.length, pitch: { x: Math.round(med.x), y: Math.round(med.y), mag: med.mag }, nn: nn }
}

// ---- PNG evidence ----------------------------------------------------------------------------
function gray2img (gray, W, H) {
  var img = new Jimp(W, H)
  for (var i = 0; i < W * H; i++) { var o = i * 4; img.bitmap.data[o] = gray[i]; img.bitmap.data[o + 1] = gray[i]; img.bitmap.data[o + 2] = gray[i]; img.bitmap.data[o + 3] = 255 }
  return img
}
function nccHeatPng (res, file) {
  var W = res.W, H = res.H, gray = new Uint8Array(W * H)
  for (var i = 0; i < W * H; i++) { var v = res.ncc[i]; gray[i] = v <= 0 ? 0 : Math.round(v * 255) }
  return gray2img(gray, W, H).writeAsync(file)
}
function seedPng (img, bbox, file) {
  var tw = bbox.x1 - bbox.x0, th = bbox.y1 - bbox.y0, crop = new Jimp(tw, th)
  for (var y = 0; y < th; y++) for (var x = 0; x < tw; x++) {
    var g = Math.round(img.luma[(bbox.y0 + y) * img.width + (bbox.x0 + x)]), o = (y * tw + x) * 4
    crop.bitmap.data[o] = g; crop.bitmap.data[o + 1] = g; crop.bitmap.data[o + 2] = g; crop.bitmap.data[o + 3] = 255
  }
  return crop.writeAsync(file)
}
// Grayscale base image with peak centres marked as red crosses.
function peaksPng (img, peaks, file) {
  var W = img.width, H = img.height, im = new Jimp(W, H)
  for (var i = 0; i < W * H; i++) { var g = Math.round(img.luma[i]), o = i * 4; im.bitmap.data[o] = g; im.bitmap.data[o + 1] = g; im.bitmap.data[o + 2] = g; im.bitmap.data[o + 3] = 255 }
  for (var p = 0; p < peaks.length; p++) {
    for (var d = -6; d <= 6; d++) {
      mark(im, peaks[p].x + d, peaks[p].y, W, H)
      mark(im, peaks[p].x, peaks[p].y + d, W, H)
    }
  }
  return im.writeAsync(file)
}
function mark (im, x, y, W, H) {
  if (x < 0 || x >= W || y < 0 || y >= H) return
  var o = (y * W + x) * 4
  im.bitmap.data[o] = 255; im.bitmap.data[o + 1] = 0; im.bitmap.data[o + 2] = 0; im.bitmap.data[o + 3] = 255
}

// ---- fixtures --------------------------------------------------------------------------------
// seed = fractional bbox {fx0,fy0,fx1,fy1} of the WORKING (downscaled) image, capturing ~one
// watermark instance. Dumped as *-seed.png for visual confirmation; adjust fractions if a crop
// misses the glyph. role: 'target' (tiled text, must form a >=3 lattice) | 'neg' (must NOT).
var FIXTURES = [
  { name: 'TARGET TAYLOR GALE grid', slug: 'taylor', file: 'repeated-tile-template.jpg', role: 'target',
    seed: { fx0: 0.40, fy0: 0.04, fx1: 0.60, fy1: 0.12 } },
  { name: 'TARGET Delete-me dense grid', slug: 'deleteme', file: 'delete me.png', role: 'target',
    seed: { fx0: 0.01, fy0: 0.025, fx1: 0.085, fy1: 0.065 } },
  { name: 'TARGET @Watermark diagonal (busy photo)', slug: 'banner', file: 'banner-before.jpg', role: 'target',
    seed: { fx0: 0.375, fy0: 0.065, fx1: 0.57, fy1: 0.155 } },
  { name: 'NEG single Copyright (watermark, NOT tiled)', slug: 'copyright', file: 'copyright-watermark.png', role: 'neg',
    seed: { fx0: 0.45, fy0: 0.47, fx1: 0.93, fy1: 0.56 } },
  { name: 'NEG flying-eagle photo (no watermark)', slug: 'eagle', file: 'high_resolution_flying_eagle_4k_8k_hd.jpg', role: 'neg',
    seed: { fx0: 0.40, fy0: 0.40, fx1: 0.58, fy1: 0.52 } },
  { name: 'NEG kids1 photo (no watermark)', slug: 'kids1', file: 'kids1.jpg', role: 'neg',
    seed: { fx0: 0.40, fy0: 0.38, fx1: 0.58, fy1: 0.50 } },
  { name: 'NEG kids2 photo (no watermark)', slug: 'kids2', file: 'kids2.jpg', role: 'neg',
    seed: { fx0: 0.40, fy0: 0.38, fx1: 0.58, fy1: 0.50 } }
]

function bboxFrom (img, seed) {
  return {
    x0: Math.round(seed.fx0 * img.width), y0: Math.round(seed.fy0 * img.height),
    x1: Math.round(seed.fx1 * img.width), y1: Math.round(seed.fy1 * img.height)
  }
}
function pad (s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s }

(async function () {
  fs.mkdirSync(OUT, { recursive: true })
  fs.readdirSync(OUT).filter(function (n) { return /\.png$/.test(n) }).forEach(function (n) { fs.unlinkSync(path.join(OUT, n)) })
  var lines = []
  var log = function (s) { console.log(s); lines.push(s) }

  log('Text-watermark NCC detection SPIKE (#53) — ' + new Date().toISOString())
  log('WORK_MAX=' + WORK_MAX + '  EPS=' + EPS + '  cutoffs=' + NCC_CUTOFFS.join('/') +
      '  NMS=anisotropic(tw,th)  pitchTol=' + (PITCH_TOL_MAG * 100) + '%/' + PITCH_TOL_DEG + 'deg')
  log('Local-normalisation window W = template footprint (intrinsic to fast-NCC; not a free knob).')

  var results = {}
  var pngJobs = []
  for (var f = 0; f < FIXTURES.length; f++) {
    var fx = FIXTURES[f]
    var img = await load(fx.file)
    var bbox = bboxFrom(img, fx.seed)
    var tw = bbox.x1 - bbox.x0, th = bbox.y1 - bbox.y0
    var res = fastNCC(img, bbox)

    log('\n=== ' + fx.name + ' ===')
    log('  working ' + img.width + 'x' + img.height + ' (scale ' + img.scale.toFixed(3) + ')  template ' +
        tw + 'x' + th + ' @ (' + bbox.x0 + ',' + bbox.y0 + ')  NMS=' + tw + 'x' + th)
    log('  ' + pad('cutoff', 6) + '  ' + pad('peaks', 5) + '  ' + pad('pitch', 14) + '  ' + pad('score', 6) + '  lattice')

    var perCutoff = {}
    for (var ci = 0; ci < NCC_CUTOFFS.length; ci++) {
      var cut = NCC_CUTOFFS[ci]
      var ex = extractPeaks(res, cut)
      var lat = latticeScore(ex.peaks)
      var isLattice = ex.peaks.length >= LATTICE_MIN_PEAKS && lat.score >= LATTICE_MIN_SCORE
      perCutoff[cut] = { peaks: ex.peaks.length, score: lat.score, pitch: lat.pitch, lattice: isLattice, list: ex.peaks }
      var pstr = lat.pitch ? ('(' + lat.pitch.x + ',' + lat.pitch.y + ') |' + Math.round(lat.pitch.mag) + '|') : '—'
      log('  ' + pad(cut, 6) + '  ' + pad(ex.peaks.length, 5) + '  ' + pad(pstr, 14) + '  ' +
          pad(lat.score.toFixed(2), 6) + '  ' + (isLattice ? 'YES' : 'no'))
    }
    results[fx.slug] = { fx: fx, img: img, bbox: bbox, res: res, perCutoff: perCutoff }

    // Evidence: seed crop, NCC heatmap, peak overlay at cutoff 0.5 (mid).
    pngJobs.push(seedPng(img, bbox, path.join(OUT, fx.slug + '-seed.png')))
    pngJobs.push(nccHeatPng(res, path.join(OUT, fx.slug + '-ncc-heat.png')))
    pngJobs.push(peaksPng(img, perCutoff[0.5].list, path.join(OUT, fx.slug + '-peaks.png')))
  }
  await Promise.all(pngJobs)

  // ---- pick the cutoff that best separates targets from negatives ----------------------------
  // For each cutoff: do ALL targets form a lattice AND NO negative forms one? Prefer the highest
  // such cutoff (most conservative). If none is perfectly clean, report the best separation.
  log('\n=== CUTOFF SEPARATION (targets must latch, negatives must not) ===')
  var cleanCutoffs = []
  for (var c = 0; c < NCC_CUTOFFS.length; c++) {
    var cut2 = NCC_CUTOFFS[c]
    var tgtLatch = 0, tgtTotal = 0, negLatch = 0, negTotal = 0, negNames = []
    for (var s = 0; s < FIXTURES.length; s++) {
      var r = results[FIXTURES[s].slug].perCutoff[cut2]
      if (FIXTURES[s].role === 'target') { tgtTotal++; if (r.lattice) tgtLatch++ } else { negTotal++; if (r.lattice) { negLatch++; negNames.push(FIXTURES[s].slug) } }
    }
    var clean = tgtLatch === tgtTotal && negLatch === 0
    if (clean) cleanCutoffs.push(cut2)
    log('  cutoff ' + cut2 + ':  targets latched ' + tgtLatch + '/' + tgtTotal +
        '   negatives latched ' + negLatch + '/' + negTotal +
        (negNames.length ? ' [' + negNames.join(',') + ']' : '') + (clean ? '   <- CLEAN' : ''))
  }
  var chosen = cleanCutoffs.length ? cleanCutoffs[cleanCutoffs.length - 1] : null

  // ---- go/no-go ------------------------------------------------------------------------------
  log('\n=== GO / NO-GO ===')
  var allTargetsLatch = chosen != null
  var decision
  if (allTargetsLatch) {
    decision = 'GO — at NCC cutoff ' + chosen + ', all ' +
      FIXTURES.filter(function (x) { return x.role === 'target' }).length +
      ' tiled-text targets reach a >=' + LATTICE_MIN_PEAKS + '-instance consistent-pitch lattice ' +
      'AND every negative control (clean photos + the single non-tiled Copyright mark) stays below ' +
      'the lattice gate. FFT-based NCC of the user seed template recovers text-watermark instances ' +
      'that the FFT comb misses on a one-instance region. Proceed to an engine build.'
  } else {
    // Report the best partial separation for the pivot decision.
    decision = 'NO-GO (as configured) — no single NCC cutoff cleanly latches all targets while ' +
      'rejecting all negatives. Inspect the per-cutoff table + heatmaps: tune the seed bbox, cutoff, ' +
      'or pitch tolerance, or fall back to running detectTiling() WHOLE-IMAGE (TAYLOR GALE = combCount 9 ' +
      'whole-image, LEARNINGS #50) instead of region-constrained. Record the dead-end either way.'
  }
  log('  ' + decision)

  log('\n=== BUILD HAND-OFF (recommended parameters for the follow-up engine fn) ===')
  log('  NCC cutoff:            ' + (chosen != null ? chosen : '(needs tuning — see table)'))
  log('  NMS:                   anisotropic (dx<template_w AND dy<template_h) — isotropic')
  log('                         max(tw,th) over-suppresses short axes on wide-short text crops')
  log('  Normalisation window:  template footprint (tw x th) — fast-NCC local mean/variance window;')
  log('                         NOT a free LCN radius, so the #49 W-tuning trap does not apply here.')
  log('  EPS denominator guard: ' + EPS + '  (flat template/region -> 0, never NaN)')
  log('  Lattice gate:          >=' + LATTICE_MIN_PEAKS + ' peaks AND pitch-consistency score >=' + LATTICE_MIN_SCORE)
  log('  Proposed shape:        detectTextTiling(imageData, seedBbox) -> { instances, tileBasis,')
  log('                         confidence } with tileBasis compatible with propagateMask(); wire as')
  log('                         the runTile() fallback when detectTiling().combCount < COMB_MIN.')

  log('\nEvidence (seed crops, NCC heatmaps, peak overlays + this log) -> ' + OUT)
  fs.writeFileSync(path.join(OUT, 'results.txt'), lines.join('\n') + '\n')
})().catch(function (e) { console.error(e); process.exit(1) })
