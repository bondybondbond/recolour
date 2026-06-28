#!/usr/bin/env node
/*
 * SPIKE (throwaway) — frequency-domain tiling detection (#48, T29 Phase 2b).
 *
 *   node scripts/spike-fft-tiling.js
 *
 * #45 bailed out: the spatial Sobel+shape pipeline cannot isolate a faint tiled watermark from
 * photographic content (LEARNINGS CORE-16). The hypothesis for #48 is that a tiled watermark's ONLY
 * separable signal is its regular tiling. This script answers ONE question before any real build is
 * attempted:
 *
 *   Do the real WhatsApp fixtures show a clean, separable periodic-tiling signal above the photo
 *   noise floor?
 *
 * METHOD — autocorrelation (Wiener-Khinchin: AC = IFFT(|FFT|^2)). The 2D FFT magnitude spectrum is
 * dominated by an axis-cross of leakage that makes raw spectral-peak lattice-fitting fragile (first
 * cut of this spike had the positive control FAIL for exactly that reason). Autocorrelation is the
 * textbook period estimator: a tiled image produces a regular LATTICE of peaks at multiples of the
 * tile vector, the central zero-lag lobe is excluded, and the strongest secondary peak gives both
 * the tile period (its lag) and a clean strength number (peak / local AC noise floor). The spectrum
 * PNG is still dumped as secondary evidence.
 *
 * It is NOT part of `npm test` and touches nothing in web/ or test/. The *script* is throwaway, but
 * its OUTPUT is durable evidence: autocorrelation + spectrum PNGs and a results.txt are written to
 * scripts/evidence/spike-fft/ so the build/no-build decision can cite them.
 *
 * Three-way verdict per fixture (the JPEG trap, see Risk in the dev plan): WhatsApp recompresses on
 * send, and JPEG's 8x8 DCT quantisation injects its OWN periodic signal at an 8px lag. So a null
 * tiling result is ambiguous:
 *   1. strong periodic peak at a watermark-scale lag   -> TILING PRESENT -> BUILD the engine
 *   2. dominant periodicity only at the 8px JPEG lag   -> "signal destroyed by recompression"
 *   3. no significant secondary peak at any lag        -> no separable tiling signal in source
 *
 * CONTROLS (validate the spike before trusting it):
 *   + repeated-tile-template.jpg  "TAYLOR GALE" bold tiled overlay  -> MUST register as tiling
 *   - high_resolution_flying_eagle_4k_8k_hd.jpg  natural photo      -> MUST register as no-tiling
 *   (watermark.jpg is included as a reference: a Lorem-Ipsum doc whose regular TEXT LINE spacing is
 *    a legitimately periodic signal the method should also pick up — a sanity check, not a control.)
 */
'use strict'

var fs = require('fs')
var path = require('path')
var _Jimp = require('jimp')
var Jimp = _Jimp.default || _Jimp // CORE-1: CJS vs ESM

// The 4K/8K negative-control photo blows jpeg-js's default memory cap. Raise it (decode-time only,
// this is a throwaway harness) so a genuinely non-periodic high-res photo can be the negative control.
var jpegjs = require('jpeg-js')
Jimp.decoders['image/jpeg'] = function (data) {
  return jpegjs.decode(data, { maxMemoryUsageInMB: 2048, maxResolutionInMP: 600 })
}

var FIX = path.join(__dirname, '..', 'test', 'files')
var OUT = path.join(__dirname, 'evidence', 'spike-fft')

var N = 512            // power-of-2 analysis window (largest po2 <= 560, the fixture height)
var LAG_MIN = 10       // exclude the central zero-lag lobe (broad photo autocorrelation)
var LAG_MAX = 200      // largest tile period we bother to detect (few reps -> unreliable beyond)
var PEAK_FACTOR = 6    // a secondary AC peak must exceed (noise floor) * this to count as tiling
var JPEG_LAG = 8       // JPEG 8x8 DCT block period -> autocorrelation peak at lag 8
var TOP_N = 12         // peaks to print
var COMB_RATIO = 2.5   // a peak must clear this peak/floor ratio to join the harmonic-comb tally
var COMB_MIN = 4       // >= this many collinear harmonics (k*fundamental) == a real tiling comb

// ---- 1D radix-2 iterative FFT (in place); inverse = conjugate-twiddle, caller divides by n -----
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

// 2D FFT (forward or inverse) over NxN planes: transform every row then every column. Inverse
// divides the whole plane by N*N at the end.
function fft2 (re, im, inverse) {
  var lineRe = new Float64Array(N), lineIm = new Float64Array(N), x, y
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
  if (inverse) { var s = 1 / (N * N); for (var i = 0; i < re.length; i++) { re[i] *= s; im[i] *= s } }
}

// ---- decode + window -------------------------------------------------------------------------
function decode (file) {
  return Jimp.read(path.join(FIX, file)).then(function (im) {
    return { data: im.bitmap.data, width: im.bitmap.width, height: im.bitmap.height }
  })
}

// Centred NxN luminance crop, edge-clamped if the image is smaller than N in some axis.
function lumaWindow (img) {
  var out = new Float64Array(N * N)
  var ox = Math.floor((img.width - N) / 2), oy = Math.floor((img.height - N) / 2)
  for (var y = 0; y < N; y++) {
    var sy = Math.min(img.height - 1, Math.max(0, oy + y))
    for (var x = 0; x < N; x++) {
      var sx = Math.min(img.width - 1, Math.max(0, ox + x))
      var o = (sy * img.width + sx) * 4
      out[y * N + x] = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]
    }
  }
  return out
}

// Detrend (subtract mean) + separable 2D Hann window to suppress crop-edge spectral leakage.
function detrendHann (luma) {
  var mean = 0, i
  for (i = 0; i < luma.length; i++) mean += luma[i]
  mean /= luma.length
  var hann = new Float64Array(N)
  for (i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)))
  var re = new Float64Array(N * N)
  for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) re[y * N + x] = (luma[y * N + x] - mean) * hann[y] * hann[x]
  return re
}

// ---- autocorrelation (the primary detector) --------------------------------------------------
// AC = IFFT(|FFT(windowed)|^2). Returns the DC(zero-lag)-centred real autocorrelation, normalised
// so zero-lag = 1.  Also returns the raw power-spectrum magnitude (shifted) for the evidence PNG.
function autocorrelation (windowed) {
  var re = Float64Array.from(windowed), im = new Float64Array(N * N), i
  fft2(re, im, false)
  // magnitude spectrum (shifted) for the PNG, and power spectrum in place for the inverse
  var magShift = new Float64Array(N * N)
  for (var y = 0; y < N; y++) {
    var sy = (y + N / 2) % N
    for (var x = 0; x < N; x++) {
      var sx = (x + N / 2) % N, o = y * N + x
      var pw = re[o] * re[o] + im[o] * im[o]
      magShift[sy * N + sx] = Math.sqrt(pw)
      re[o] = pw; im[o] = 0
    }
  }
  fft2(re, im, true) // inverse -> autocorrelation (circular), zero-lag at [0,0]
  var ac = new Float64Array(N * N)
  var zero = re[0] || 1
  for (y = 0; y < N; y++) {
    var sy2 = (y + N / 2) % N
    for (var x2 = 0; x2 < N; x2++) {
      var sx2 = (x2 + N / 2) % N
      ac[sy2 * N + sx2] = re[y * N + x2] / zero // normalise: zero-lag -> 1, now centred
    }
  }
  return { ac: ac, mag: magShift }
}

function median (arr) {
  var a = Float64Array.from(arr).sort()
  var n = a.length
  return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2])
}

// Find the strongest secondary autocorrelation peak (3x3 local max) in the lag annulus
// [LAG_MIN, LAG_MAX], upper half-plane (each physical lag once). Returns peaks ranked by AC value,
// plus the local AC noise floor (median over the annulus).
function acPeaks (ac) {
  var cy = N / 2, cx = N / 2, vals = [], peaks = []
  for (var y = 1; y < N - 1; y++) {
    var dy = y - cy
    for (var x = 1; x < N - 1; x++) {
      var dx = x - cx, r2 = dx * dx + dy * dy
      if (r2 < LAG_MIN * LAG_MIN || r2 > LAG_MAX * LAG_MAX) continue
      vals.push(Math.abs(ac[y * N + x]))
      if (dy < 0 || (dy === 0 && dx <= 0)) continue // upper half-plane dedupe
      var v = ac[y * N + x]
      if (v < ac[(y - 1) * N + x] || v < ac[(y + 1) * N + x] ||
          v < ac[y * N + x - 1] || v < ac[y * N + x + 1] ||
          v < ac[(y - 1) * N + x - 1] || v < ac[(y - 1) * N + x + 1] ||
          v < ac[(y + 1) * N + x - 1] || v < ac[(y + 1) * N + x + 1]) continue
      peaks.push({ lx: dx, ly: dy, v: v })
    }
  }
  var floor = median(vals) || 1e-9
  peaks.sort(function (a, b) { return b.v - a.v })
  return { peaks: peaks.slice(0, TOP_N), floor: floor }
}

// HARMONIC-COMB SCORE — the key signal. A tiled overlay autocorrelates as a regular comb of peaks
// at k*fundamental along the tile direction (a fence/one-off feature does not). Take the smallest-lag
// strong peak as the fundamental, then count strong peaks whose lag is (a) a near-integer multiple of
// the fundamental's length AND (b) roughly collinear with it. >= COMB_MIN such peaks == real tiling.
function combScore (peaks, floor, ratio) {
  var strong = peaks.filter(function (p) { return p.v / floor >= ratio })
  if (!strong.length) return { count: 0, fund: null }
  var fund = strong[0]
  for (var i = 1; i < strong.length; i++) {
    if (Math.hypot(strong[i].lx, strong[i].ly) < Math.hypot(fund.lx, fund.ly)) fund = strong[i]
  }
  var fr = Math.hypot(fund.lx, fund.ly) || 1
  var dirx = fund.lx / fr, diry = fund.ly / fr, count = 0
  for (var p = 0; p < strong.length; p++) {
    var r = Math.hypot(strong[p].lx, strong[p].ly)
    var k = r / fr
    var collinear = Math.abs((strong[p].lx * dirx + strong[p].ly * diry) / r)
    if (Math.abs(k - Math.round(k)) <= 0.2 && collinear > 0.85) count++
  }
  return { count: count, fund: fund, fr: fr }
}

// AC strength at a specific lag (max over a +-1 window), as a ratio to the floor.
function acAtLag (ac, lx, ly, floor) {
  var cy = N / 2, cx = N / 2, best = -Infinity
  for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
    var y = cy + ly + oy, x = cx + lx + ox
    if (y < 0 || y >= N || x < 0 || x >= N) continue
    if (ac[y * N + x] > best) best = ac[y * N + x]
  }
  return best / floor
}

// ---- PNG dumps -------------------------------------------------------------------------------
function writeGrayPng (gray, w, h, file) {
  var img = new Jimp(w, h)
  for (var i = 0; i < w * h; i++) {
    img.bitmap.data[i * 4] = gray[i]; img.bitmap.data[i * 4 + 1] = gray[i]
    img.bitmap.data[i * 4 + 2] = gray[i]; img.bitmap.data[i * 4 + 3] = 255
  }
  return img.writeAsync(file)
}

function spectrumPng (mag, file) {
  var gray = new Uint8Array(N * N), max = 0, i
  for (i = 0; i < mag.length; i++) { var l = Math.log1p(mag[i]); if (l > max) max = l }
  max = max || 1
  for (i = 0; i < mag.length; i++) gray[i] = Math.round(Math.log1p(mag[i]) / max * 255)
  return writeGrayPng(gray, N, N, file)
}

// Autocorrelation evidence image: blank the central zero-lag lobe, then normalise the rest to
// [0,255] so the lattice of secondary peaks (if any) is visible to the eye.
function acPng (ac, file) {
  var cy = N / 2, cx = N / 2, gray = new Uint8Array(N * N)
  var min = Infinity, max = -Infinity, y, x
  for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
    var dx = x - cx, dy = y - cy
    if (dx * dx + dy * dy < LAG_MIN * LAG_MIN) continue
    var v = ac[y * N + x]; if (v < min) min = v; if (v > max) max = v
  }
  var span = (max - min) || 1
  for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
    var ddx = x - cx, ddy = y - cy
    gray[y * N + x] = (ddx * ddx + ddy * ddy < LAG_MIN * LAG_MIN)
      ? 0 : Math.round((ac[y * N + x] - min) / span * 255)
  }
  return writeGrayPng(gray, N, N, file)
}

// ---- per-fixture pipeline --------------------------------------------------------------------
function analyse (name, slug, img, log) {
  log('\n=== ' + name + '  (' + img.width + 'x' + img.height + ', window ' + N + ') ===')
  var windowed = detrendHann(lumaWindow(img))
  var r = autocorrelation(windowed)
  var pk = acPeaks(r.ac)
  var floor = pk.floor
  var peaks = pk.peaks

  log('AC noise floor (annulus median |ac|): ' + floor.toExponential(2))
  log('top autocorrelation peaks (lag px -> ratio peak/floor):')
  for (var i = 0; i < peaks.length; i++) {
    var p = peaks[i]
    log('  lag(' + String(p.lx).padStart(4) + ',' + String(p.ly).padStart(4) + ')  |lag|=' +
        Math.round(Math.hypot(p.lx, p.ly)) + 'px  ratio=' + (p.v / floor).toFixed(2))
  }
  var jpeg = Math.max(acAtLag(r.ac, JPEG_LAG, 0, floor), acAtLag(r.ac, 0, JPEG_LAG, floor),
                      acAtLag(r.ac, JPEG_LAG, JPEG_LAG, floor))
  var comb = combScore(peaks, floor, COMB_RATIO)       // clean comb (controls reach ~4x floor)
  var weak = combScore(peaks, floor, 2.0)              // a whisper of a comb at the noise floor
  var fundLag = comb.fund ? Math.round(comb.fr) : 0
  var weakLag = weak.fund ? Math.round(weak.fr) : 0
  log('JPEG 8px-block autocorrelation strength @ lag 8: ratio=' + jpeg.toFixed(2))
  log('harmonic comb: ' + comb.count + ' collinear k*fundamental peaks (>=' + COMB_RATIO + 'x floor)' +
      (comb.fund ? ', fundamental lag ~' + fundLag + 'px' : '') +
      '  |  weak (>=2.0x): ' + weak.count + (weak.fund ? ' @ ~' + weakLag + 'px' : ''))

  // 4-way verdict --------------------------------------------------------------------------
  //   TILING   : a clean harmonic comb (>= COMB_MIN peaks) at a watermark-scale fundamental.
  //   MARGINAL : only a WEAK comb (>=2 collinear harmonics at >=2.0x) at watermark scale — the
  //              signal exists but sits at the photographic noise floor (the WhatsApp case).
  //   JPEG     : the only periodicity is the ~8px JPEG block grid (no watermark comb).
  //   NONE     : no periodic structure at all.
  var cleanScale = fundLag > JPEG_LAG + 2
  var weakScale = weakLag > JPEG_LAG + 2
  var verdict
  if (comb.count >= COMB_MIN && cleanScale) {
    verdict = 'TILING PRESENT (fundamental ~' + fundLag + 'px, ' + comb.count + '-peak comb) -> BUILD candidate'
  } else if (weak.count >= 2 && weakScale) {
    verdict = 'MARGINAL — faint ' + weak.count + '-peak comb @ ~' + weakLag + 'px at the noise floor ' +
              '(top peak only ' + (peaks.length ? (peaks[0].v / floor).toFixed(1) : '0') +
              'x vs ~4x for the clean controls). Not separable as-is; pre-processing spike needed.'
  } else if (jpeg >= PEAK_FACTOR) {
    verdict = 'NO watermark tiling; only periodicity is the ~8px JPEG block grid (jpeg=' + jpeg.toFixed(1) + 'x)'
  } else {
    verdict = 'NO periodic tiling signal (comb ' + comb.count + ', weak ' + weak.count + ', jpeg ' + jpeg.toFixed(1) + 'x)'
  }
  log('VERDICT: ' + verdict)

  return Promise.all([
    spectrumPng(r.mag, path.join(OUT, slug + '-spectrum.png')),
    acPng(r.ac, path.join(OUT, slug + '-autocorr.png'))
  ]).then(function () {
    log('  evidence: ' + slug + '-spectrum.png, ' + slug + '-autocorr.png')
    return { name: name, verdict: verdict }
  })
}

(async function () {
  fs.mkdirSync(OUT, { recursive: true })
  var lines = []
  var log = function (s) { console.log(s); lines.push(s) }

  log('Tiling-detection SPIKE (#48), autocorrelation method — ' + new Date().toISOString())
  log('window=' + N + '  LAG_MIN=' + LAG_MIN + '  LAG_MAX=' + LAG_MAX + '  PEAK_FACTOR=' + PEAK_FACTOR)

  var fixtures = [
    { name: 'CONTROL+ repeated-tile-template.jpg "TAYLOR GALE" bold tiling (MUST tile)', slug: 'ctrl-tiled', file: 'repeated-tile-template.jpg' },
    { name: 'CONTROL+ banner-before.jpg "@Watermark" diagonal tiling (MUST tile)', slug: 'ctrl-tiled2', file: 'banner-before.jpg' },
    { name: 'CONTROL- flying-eagle photo, no watermark (MUST NOT tile)', slug: 'ctrl-notile', file: 'high_resolution_flying_eagle_4k_8k_hd.jpg' },
    { name: 'REF watermark.jpg (Lorem doc: text-line periodicity is real)', slug: 'ref-textdoc', file: 'watermark.jpg' },
    { name: 'WhatsApp .19 (real target)', slug: 'whatsapp-19', file: 'WhatsApp Image 2026-06-23 at 19.34.19.jpeg' },
    { name: 'WhatsApp .50 (real target)', slug: 'whatsapp-50', file: 'WhatsApp Image 2026-06-23 at 19.34.50.jpeg' }
  ]

  var summary = []
  for (var i = 0; i < fixtures.length; i++) {
    var img = await decode(fixtures[i].file)
    summary.push(await analyse(fixtures[i].name, fixtures[i].slug, img, log))
  }

  log('\n=== SUMMARY ===')
  summary.forEach(function (s) { log('  ' + s.name + '\n      -> ' + s.verdict) })
  log('\nEvidence (PNGs + this log) written to: ' + OUT)
  fs.writeFileSync(path.join(OUT, 'results.txt'), lines.join('\n') + '\n')
})().catch(function (e) { console.error(e); process.exit(1) })
