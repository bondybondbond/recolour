/*
 * recolour GUI — app glue (T23).
 *
 * The first JavaScript layer over the T22 HTML/CSS shell. Wires:
 *   • file load (drag-drop + click-to-browse) -> draw into <canvas>
 *   • on-canvas eyedropper with a floating pixel-zoom magnifier loupe
 *   • pick a pixel -> set target colour -> one-shot live preview (T21 engine)
 *   • Reset (revert to the original image)
 *
 * No modules / no fetch — must run from file:// opened directly in Chrome. The
 * colour engine is loaded first as a <script> and read off window.RecolourEngine.
 *
 * DELIBERATELY NOT the browser EyeDropper API: it is Chromium-only, requires
 * https/localhost, exits on blur and breaks on file://. We sample getImageData
 * on the canvas instead (see design/prototype-a.html SPEC + LEARNINGS).
 */
(function () {
  'use strict'

  var Engine = window.RecolourEngine

  // --- DOM refs (all present in the T22 shell) ---
  var app = document.getElementById('app')
  var sidebar = document.getElementById('sidebar')
  var dropzone = document.getElementById('dropzone')
  var canvas = document.getElementById('canvas')
  var pickerWell = document.getElementById('pickerWell')
  var loupe = document.getElementById('loupe')
  var pickerHex = document.getElementById('pickerHex')
  var tolerance = document.getElementById('tolerance')
  var tolVal = document.getElementById('tolVal')
  var recentGrid = document.getElementById('recentGrid')
  var recentRow = recentGrid.parentNode // .recent-row wraps the grid + "+" opener
  var paletteBtn = document.getElementById('paletteBtn')
  var smartFillToggle = document.getElementById('smartFill')
  var includeShadeToggle = document.getElementById('includeShades')
  var shadeLabel = document.getElementById('shadeLabel')
  var shadeSub = document.getElementById('shadeSub')
  var sliderRow = tolerance.parentNode // .slider-row wraps the meta labels + input
  var resetBtn = document.getElementById('resetBtn')
  var undoBtn = document.getElementById('undoBtn')
  var canvasArea = canvas.parentNode
  var canvasHint = document.querySelector('.canvas-hint')
  var canvasHintDefault = canvasHint ? canvasHint.textContent : ''

  // X-ray view (T29 Phase 1) — display-only contrast-boost toggle
  var xrayBtn = document.getElementById('xrayBtn')

  // Auto-detect watermark (T29 Phase 2) — display-only candidate overlay
  var detectBtn = document.getElementById('detectBtn')
  var detectOverlay = document.getElementById('detectOverlay')

  // Tile-fill propagation (T29 Phase 3, #52)
  var tileBtn = document.getElementById('tileBtn')
  var tileOverlay = document.getElementById('tileOverlay')
  var tileConfirm = document.getElementById('tileConfirm')
  var tileCount = document.getElementById('tileCount')
  var tileBand = document.getElementById('tileBand')
  var tileSubchip = document.getElementById('tileSubchip')
  var tileAccept = document.getElementById('tileAccept')
  var tileCancel = document.getElementById('tileCancel')

  // Region selection (T17)
  var regionBtn = document.getElementById('regionBtn')
  var regionRect = document.getElementById('regionRect')
  var regionClear = document.getElementById('regionClear')

  // Before/after modal (T24)
  var baBtn = document.getElementById('baBtn')
  var modal = document.getElementById('modal')
  var modalClose = document.getElementById('modalClose')
  var baBefore = document.getElementById('baBefore')
  var baAfter = document.getElementById('baAfter')

  var ctx = canvas.getContext('2d', { willReadFrequently: true })

  // --- State ---
  var originalImageData = null // immutable source pixels, captured once per load
  var originalSrc = null       // original image as a data URL, for the modal "before"
  var targetRgb = null         // [r,g,b] of the last picked pixel, or null
  var picking = false          // is eyedropper armed?

  // Undo / multi-pass history (T26). `baseImageData` is the committed starting point
  // for the *current* operation — renderPreview() builds on THIS, not originalImageData,
  // so each pick stacks on the previous result instead of discarding it. `undoStack`
  // holds the previous bases (most-recent last), capped at MAX_UNDO.
  // TRAP: never write baseImageData.data[i] in place — entries on undoStack share no
  // copy-on-write protection, so an in-place write would silently corrupt a snapshot.
  // Always reassign baseImageData (to a fresh ImageData / getImageData) instead.
  var baseImageData = null
  var undoStack = []
  var MAX_UNDO = 10

  // Replace-colour history (T25). `recents` is the source of truth; localStorage is
  // a best-effort mirror. `selectedReplaceHex` is tracked in state (not read off the
  // DOM) so the selection survives a full grid re-render.
  var STORAGE_KEY = 'recolour:recentColours'
  var MAX_RECENT = 5
  var recents = []             // array of uppercase #RRGGBB, most-recent-first
  var selectedReplaceHex = '#FFFFFF'

  // Include shades gate. When off, tolerance is forced to 0 — exact hex match only.
  // When on, the tolerance slider is active and the engine uses the slider value.
  var includeShades = true

  // Smart fill (T16). When on, renderPreview() uses Engine.smartFill() — cardinal
  // distance-weighted interpolation — instead of the flat selected replace colour.
  // Each matched pixel is reconstructed from the nearest original background pixel in
  // each of the 4 cardinal directions, weighted by 1/distance. The Panel 2 swatches are
  // dimmed + disabled while it's active because the flat colour is not used.
  var smartFillOn = false

  // X-ray view (T29 Phase 1). Pure display aid: when on, a CSS `filter` on the canvas element
  // boosts contrast so faint / semi-transparent watermarks are visible to eyedropper. It does NOT
  // touch pixels — picks (getImageData), preview, undo and export (toBlob) all read the true backing
  // store — so it is independent of the eyedropper/region interaction modes (no mutual exclusivity).
  var xrayOn = false

  // Auto-detect watermark (T29 Phase 2). Pure display aid: runs the engine's edge-detection +
  // connected-components pass to flag text-shaped regions, then paints them onto #detectOverlay (a
  // sibling canvas) as a translucent tint + bounding boxes. Like X-ray it NEVER touches the backing
  // store — no fill is applied (the confirm→fill step is the future T43 routing slice, #44). So
  // picks, preview, undo and export are unaffected, and there is no mutual exclusivity with the
  // eyedropper. The overlay is a one-shot snapshot: it clears on new image / Reset / Undo / commit.
  var detectOn = false
  var DETECT_MAX_PIXELS = 4000000 // above this, detection can jank the main thread — warn first (#43)

  // Tile-fill propagation (T29 Phase 3, #52). `tileOn` arms the confirm overlay; `tileResult` caches
  // the last propagation { seed, propMask, instances, sub, combCount, basis, tileDoubled } so the
  // subharmonic "double the spacing" button can re-propagate without re-detecting. Like auto-detect
  // the overlay is display-only until the user Accepts; it clears on new image / Reset / Undo /
  // commit / clear-region. Requires a committed region (the seed box around one instance) to run.
  var tileOn = false
  var tileResult = null
  var TILE_MAX_PIXELS = DETECT_MAX_PIXELS // detectTiling's multi-radius FFT is heavy — warn + defer (#43)

  // Region selection (T17). `region` is the active bounding box in IMAGE pixel coords
  // ({x,y,width,height}) or null for whole-image. `selecting` arms drag-to-draw mode (mutually
  // exclusive with the eyedropper). The engine honours `region` on every renderPreview(); the
  // box persists across picks/passes until Clear or Reset. A degenerate drag (a bare click or
  // sub-MIN_REGION box) is discarded so the engine never receives a 0×0 rect.
  var region = null
  var selecting = false
  var dragging = false
  var dragAnchor = null
  var MIN_REGION = 4 // image px — below this on either axis the drag is treated as a click
  // Live-preview snapshot for the loupe (T33-fix). renderPreview() stores the `work`
  // ImageData here so drawMagnifier/pixelRgba can show the in-progress result rather than
  // the stale committed base. Cleared whenever targetRgb is discarded (undo, reset, etc.).
  var livePreviewImageData = null
  // Resize (T33). `resizing` is the active handle id ('nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w')
  // while a handle is dragged, else null. `regionBeforeResize` snapshots the box at drag
  // start so Esc can restore it. Resize only ever mutates an existing committed region.
  var resizing = null
  var regionBeforeResize = null

  // Floating magnifier (created lazily on first load).
  var MAG_RADIUS = 4           // 4 px each side of centre -> 9x9 grid
  var MAG_ZOOM = 14            // on-screen px per source px
  var MAG_PX = (MAG_RADIUS * 2 + 1) * MAG_ZOOM // 126px square
  var MAG_BORDER = 2           // .magnifier border width (px, each side) — see styles.css
  var magCanvas = null
  var magCtx = null

  // ---------------------------------------------------------------------------
  // Colour helpers (kept here; the engine stays colour-space only).
  // ---------------------------------------------------------------------------
  function toHex2 (n) {
    var s = n.toString(16)
    return s.length === 1 ? '0' + s : s
  }

  function rgbToHex (r, g, b) {
    return ('#' + toHex2(r) + toHex2(g) + toHex2(b)).toUpperCase()
  }

  function hexToRgb (hex) {
    var h = hex.replace('#', '')
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }

  // HSV helpers — drive the T28 picker's SV box + hue slider. h in [0,360), s/v in [0,1].
  function hsvToRgb (h, s, v) {
    h = (h % 360 + 360) % 360
    var c = v * s
    var x = c * (1 - Math.abs((h / 60) % 2 - 1))
    var m = v - c
    var r = 0, g = 0, b = 0
    if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c } else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c } else if (h < 300) { r = x; b = c } else { r = c; b = x }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
  }

  function rgbToHsv (r, g, b) {
    r /= 255; g /= 255; b /= 255
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
    var h = 0
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h *= 60
      if (h < 0) h += 360
    }
    return { h: h, s: max === 0 ? 0 : d / max, v: max }
  }

  // ---------------------------------------------------------------------------
  // File loading
  // ---------------------------------------------------------------------------
  var fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/*'
  fileInput.style.display = 'none'
  document.body.appendChild(fileInput)

  function handleFile (file) {
    if (!file || file.type.indexOf('image/') !== 0) return // ignore non-images
    var reader = new FileReader()
    reader.onload = function (e) {
      var img = new Image()
      // Stash the source data URL BEFORE the (possibly synchronous) onload fires,
      // so the modal "before" can never read a stale src on a fast-loading image.
      originalSrc = e.target.result
      img.onload = function () { renderImage(img) }
      img.src = e.target.result // local data URL -> canvas stays untainted
    }
    reader.readAsDataURL(file)
  }

  function renderImage (img) {
    // Backing store = image-native pixels (NOT DPR-scaled). The pick coordinate
    // mapping (canvas.width / rect.width) depends on this — see app.js pick logic.
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    ctx.drawImage(img, 0, 0)
    originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

    // Fresh image -> the committed base is the original, history is empty (T26).
    baseImageData = new ImageData(
      new Uint8ClampedArray(originalImageData.data),
      canvas.width,
      canvas.height
    )
    undoStack = []

    // Flip to loaded state (T22 visual-state contract).
    app.classList.add('loaded')
    sidebar.classList.remove('disabled')

    ensureMagnifier()
    // A fresh image invalidates any previous pick (and any queued preview frame).
    cancelScheduledPreview()
    targetRgb = null
    livePreviewImageData = null // any prior preview is for a different image
    region = null // a new image drops any prior selection (T17)
    regionRect.style.display = 'none'
    disarmPicker()
    exitSelecting()
    setXray(false) // a fresh image starts with the normal (un-enhanced) view (T29)
    setDetect(false) // drop any auto-detect overlay from a previous image (T29 Phase 2)
    setTile(false) // drop any tile-fill propagation overlay from a previous image (T29 Phase 3, #52)
    resetPickerWell()
    updateControls() // no recolour yet on the new image -> undo + before/after disabled
  }

  // Click-to-browse
  dropzone.addEventListener('click', function () { fileInput.click() })
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0])
    fileInput.value = '' // allow re-selecting the same file
  })

  // Drag-and-drop onto the empty-state dropzone.
  dropzone.addEventListener('dragover', function (e) {
    e.preventDefault()
    dropzone.classList.add('dragover')
  })
  dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('dragover') })
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault()
    dropzone.classList.remove('dragover')
    if (e.dataTransfer && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0])
  })

  // Drag-and-drop onto the canvas area when an image is already loaded (to swap it).
  canvasArea.addEventListener('dragover', function (e) {
    e.preventDefault()
    if (app.classList.contains('loaded')) canvasArea.classList.add('dragover')
  })
  canvasArea.addEventListener('dragleave', function (e) {
    if (!canvasArea.contains(e.relatedTarget)) canvasArea.classList.remove('dragover')
  })
  canvasArea.addEventListener('drop', function (e) {
    e.preventDefault()
    canvasArea.classList.remove('dragover')
    if (e.dataTransfer && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0])
  })

  // Clipboard paste (Ctrl+V / Cmd+V anywhere on the page).
  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items
    if (!items) return
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        handleFile(items[i].getAsFile())
        break
      }
    }
  })

  // ---------------------------------------------------------------------------
  // Eyedropper picker mode
  // ---------------------------------------------------------------------------
  function ensureMagnifier () {
    if (magCanvas) return
    magCanvas = document.createElement('canvas')
    magCanvas.className = 'magnifier'
    magCanvas.width = MAG_PX
    magCanvas.height = MAG_PX
    magCtx = magCanvas.getContext('2d')
    magCtx.imageSmoothingEnabled = false
    canvasArea.appendChild(magCanvas)
  }

  function armPicker () {
    if (!originalImageData) return
    exitSelecting() // picker and region-draw are mutually exclusive modes (T17)
    picking = true
    app.classList.add('picking')
  }

  function disarmPicker () {
    picking = false
    app.classList.remove('picking')
    if (magCanvas) magCanvas.style.display = 'none'
  }

  // Map a mouse event to integer canvas pixel coords.
  // scale = canvas.width / rect.width: maps CSS display coords -> image pixels.
  // Do NOT multiply by devicePixelRatio — the backing store is already image-native.
  function eventToPixel (e) {
    var rect = canvas.getBoundingClientRect()
    var x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width))
    var y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height))
    x = Math.max(0, Math.min(canvas.width - 1, x))
    y = Math.max(0, Math.min(canvas.height - 1, y))
    return { x: x, y: y }
  }

  // Read a pixel from the COMMITTED state (baseImageData), not the original. This ensures
  // the eyedropper samples what is currently on the canvas after prior edits — e.g. after
  // smart-filling a watermark, hovering/clicking that area reflects the filled colours, not
  // the original red. Called after commitOperation() so baseImageData is already up-to-date.
  function pixelRgba (x, y) {
    var d = (livePreviewImageData || baseImageData).data
    var i = (y * canvas.width + x) * 4
    return [d[i], d[i + 1], d[i + 2], d[i + 3]]
  }

  // Draw the 9x9 neighbourhood around (cx,cy) into the loupe, zoomed, with a pixel grid and
  // crosshair on the centre cell. The loupe is centred on the cursor (T27) — the system cursor
  // is hidden while picking, so the centre crosshair cell IS the pixel that will be picked.
  function drawMagnifier (e, cx, cy) {
    magCtx.clearRect(0, 0, MAG_PX, MAG_PX)
    // Read from the live preview when one is active so the loupe shows in-progress results
    // (e.g. which red pixels have been recoloured at the current tolerance). Falls back to
    // the committed base when no preview is running.
    var d = (livePreviewImageData || baseImageData).data
    var w = canvas.width
    var h = canvas.height
    var size = MAG_RADIUS * 2 + 1

    // Draw pixel cells.
    for (var dy = -MAG_RADIUS; dy <= MAG_RADIUS; dy++) {
      for (var dx = -MAG_RADIUS; dx <= MAG_RADIUS; dx++) {
        var sx = cx + dx
        var sy = cy + dy
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
        var i = (sy * w + sx) * 4
        magCtx.fillStyle = 'rgba(' + d[i] + ',' + d[i + 1] + ',' + d[i + 2] + ',' + (d[i + 3] / 255) + ')'
        magCtx.fillRect((dx + MAG_RADIUS) * MAG_ZOOM, (dy + MAG_RADIUS) * MAG_ZOOM, MAG_ZOOM, MAG_ZOOM)
      }
    }

    // Adaptive grid colour: sample centre pixel luminance (sRGB coefficients),
    // use dark lines on light backgrounds and light lines on dark backgrounds.
    var ci = (cy * w + cx) * 4
    var lum = (0.2126 * d[ci] + 0.7152 * d[ci + 1] + 0.0722 * d[ci + 2]) / 255
    magCtx.strokeStyle = lum > 0.5 ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)'
    magCtx.lineWidth = 1
    for (var g = 1; g < size; g++) {
      magCtx.beginPath(); magCtx.moveTo(g * MAG_ZOOM, 0); magCtx.lineTo(g * MAG_ZOOM, MAG_PX); magCtx.stroke()
      magCtx.beginPath(); magCtx.moveTo(0, g * MAG_ZOOM); magCtx.lineTo(MAG_PX, g * MAG_ZOOM); magCtx.stroke()
    }

    // Crosshair box on the centre pixel.
    magCtx.strokeStyle = '#fff'
    magCtx.lineWidth = 1.5
    magCtx.strokeRect(MAG_RADIUS * MAG_ZOOM + 0.5, MAG_RADIUS * MAG_ZOOM + 0.5, MAG_ZOOM - 1, MAG_ZOOM - 1)

    // Position: centred exactly on the cursor (T27) so the centre crosshair cell sits on the
    // pixel that will be picked. cx2/cy2 are .canvas-area-relative — the same space magCanvas is
    // absolutely positioned in. The loupe clips at the area edges (overflow:hidden) near borders;
    // that's the accepted cursor-as-loupe trade-off (no offset, no edge-flip).
    // Centre by half the rendered box, not half the backing store: the .magnifier has a 2px
    // border each side, so the rendered box is MAG_PX + 2*MAG_BORDER. Subtracting MAG_BORDER
    // lands the geometric centre exactly on the cursor.
    var rect = canvasArea.getBoundingClientRect()
    var cx2 = e.clientX - rect.left
    var cy2 = e.clientY - rect.top
    magCanvas.style.left = (cx2 - MAG_PX / 2 - MAG_BORDER) + 'px'
    magCanvas.style.top = (cy2 - MAG_PX / 2 - MAG_BORDER) + 'px'
    magCanvas.style.display = 'block'
  }

  // Arm via the picker well. stopPropagation: the well wraps the loupe swatch, and
  // we don't want a re-arm click to bubble onward.
  pickerWell.addEventListener('click', function (e) {
    e.stopPropagation()
    if (picking) disarmPicker()
    else armPicker()
  })

  canvas.addEventListener('mousemove', function (e) {
    if (!picking || !originalImageData) return
    var p = eventToPixel(e)
    drawMagnifier(e, p.x, p.y)
  })

  // Hide the magnifier as soon as the cursor leaves the image or the surrounding area.
  canvas.addEventListener('mouseleave', function () {
    if (magCanvas) magCanvas.style.display = 'none'
  })
  canvasArea.addEventListener('mouseleave', function () {
    if (magCanvas) magCanvas.style.display = 'none'
  })

  canvas.addEventListener('click', function (e) {
    if (!picking || !originalImageData) return
    var p = eventToPixel(e)
    // Commit FIRST so baseImageData reflects the current canvas (including any live preview)
    // before pixelRgba reads from it. Order matters: pixelRgba reads baseImageData.
    commitOperation() // bake the previous live op (if any) so this pick stacks on top (T26)
    var rgba = pixelRgba(p.x, p.y)
    targetRgb = [rgba[0], rgba[1], rgba[2]]
    setPickedColour(rgbToHex(rgba[0], rgba[1], rgba[2]))
    disarmPicker()
    renderPreview()
    updateControls() // a recolour now exists -> undo + before/after meaningful
  })

  // Keyboard: Esc closes the modal (priority) else cancels picker mode; Ctrl/Cmd+Z undoes.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (pickerOpen) cancelPicker() // colour popover takes priority (T28)
      else if (modal.classList.contains('open')) closeModal()
      else if (tileOn) cancelTile() // dismiss the tile-fill confirm overlay (T29 Phase 3, #52)
      else if (resizing) cancelResize() // restore pre-drag bounds (T33) — before draw/pick
      else if (selecting) exitSelecting() // cancel an armed region-draw (T17)
      else if (picking) disarmPicker()
      return
    }
    // Undo (T26). Guard on image-loaded (originalImageData), NOT undoStack length, so
    // Ctrl+Z with no image is a clean no-op. Shift+Ctrl+Z is left for a future redo.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (!originalImageData) return
      e.preventDefault()
      undo()
    }
  })

  // ---------------------------------------------------------------------------
  // Region selection (T17)
  // ---------------------------------------------------------------------------
  // Arm/disarm drag-to-draw mode. Entering disarms the eyedropper (mutually exclusive);
  // the button's pressed state + ARIA mirror `selecting`.
  function enterSelecting () {
    if (!originalImageData) return
    disarmPicker()
    selecting = true
    app.classList.add('selecting')
    regionBtn.classList.add('active')
    regionBtn.setAttribute('aria-pressed', 'true')
  }

  function exitSelecting () {
    selecting = false
    app.classList.remove('selecting')
    regionBtn.classList.remove('active')
    regionBtn.setAttribute('aria-pressed', 'false')
  }

  regionBtn.addEventListener('click', function () {
    if (selecting) exitSelecting()
    else enterSelecting()
  })

  // Build a region rect (image px) from two pixel points. +1 makes the span inclusive of
  // both end pixels, so a 1px drag = a 1px-wide region and dragging to the far edge reaches it.
  function rectFromPoints (a, b) {
    var x0 = Math.min(a.x, b.x); var x1 = Math.max(a.x, b.x)
    var y0 = Math.min(a.y, b.y); var y1 = Math.max(a.y, b.y)
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
  }

  // Place + size #regionRect over the canvas, converting an image-px rect to CSS px via the
  // live canvas vs canvas-area bounding rects (handles letterboxing, scroll, and resize).
  // Defaults to the stored `region` so resize/scroll reposition without recomputing the rect.
  function positionRegionOverlay (rect) {
    rect = rect || region
    if (!rect) return
    var cRect = canvas.getBoundingClientRect()
    var aRect = canvasArea.getBoundingClientRect()
    var sx = cRect.width / canvas.width
    var sy = cRect.height / canvas.height
    regionRect.style.left = ((cRect.left - aRect.left) + rect.x * sx) + 'px'
    regionRect.style.top = ((cRect.top - aRect.top) + rect.y * sy) + 'px'
    regionRect.style.width = (rect.width * sx) + 'px'
    regionRect.style.height = (rect.height * sy) + 'px'
  }

  // Show/position the committed region overlay (or hide it when there is no region).
  function refreshRegionOverlay () {
    if (!region) { regionRect.style.display = 'none'; return }
    regionRect.classList.remove('drawing')
    positionRegionOverlay()
    regionRect.style.display = 'block'
  }

  function clearRegion () {
    commitOperation() // bake any live in-region preview before removing the constraint
    targetRgb = null  // no active pick after clearing — prevents a whole-image re-render
    region = null
    regionRect.style.display = 'none'
    resetPickerWell() // clear the well whether or not a pick was active
    // renderPreview() intentionally omitted: targetRgb is null so it would no-op, and the
    // canvas already shows the committed result.
    updateControls()
  }

  // mousedown begins the drag on the canvas; move + up are bound to DOCUMENT so a drag that
  // ends outside the canvas still finalises cleanly. eventToPixel clamps to image bounds, so
  // an out-of-canvas endpoint yields a valid edge-clamped rect.
  canvas.addEventListener('mousedown', function (e) {
    if (!selecting || !originalImageData) return
    e.preventDefault()
    dragging = true
    dragAnchor = eventToPixel(e)
    document.addEventListener('mousemove', onDragMove)
    document.addEventListener('mouseup', onDragEnd)
  })

  function onDragMove (e) {
    if (!dragging) return
    var rect = rectFromPoints(dragAnchor, eventToPixel(e))
    regionRect.classList.add('drawing') // hide the × handle while actively dragging
    positionRegionOverlay(rect)
    regionRect.style.display = 'block'
  }

  function onDragEnd (e) {
    if (!dragging) return
    dragging = false
    document.removeEventListener('mousemove', onDragMove)
    document.removeEventListener('mouseup', onDragEnd)
    var rect = rectFromPoints(dragAnchor, eventToPixel(e))
    dragAnchor = null
    exitSelecting()
    // Discard a bare click / sub-MIN_REGION drag — keep the prior region (if any) intact.
    if (rect.width >= MIN_REGION && rect.height >= MIN_REGION) {
      region = rect
      refreshRegionOverlay()
      renderPreview()
      updateControls()
    } else {
      refreshRegionOverlay() // restore the previous overlay (or stay hidden)
    }
  }

  // Clear (×) handle — stopPropagation so the click doesn't bubble to the canvas/area.
  regionClear.addEventListener('click', function (e) {
    e.stopPropagation()
    clearRegion()
  })

  // Resize handles (T33). mousedown on a handle starts a resize; move + up bind to DOCUMENT
  // so a drag that leaves the canvas still finalises. We work in IMAGE-pixel edges (L/T/R/B)
  // — never width/height deltas from a fixed origin — so dragging a top/left handle moves
  // region.x/region.y correctly (avoids the classic NW/N/W origin-drift bug). The overlay is
  // repositioned every frame via positionRegionOverlay(); the engine re-runs via the rAF
  // throttle. Handles only exist on a committed overlay, so `region` is guaranteed non-null.
  regionRect.addEventListener('mousedown', function (e) {
    var handle = e.target.getAttribute && e.target.getAttribute('data-handle')
    if (!handle || !region || selecting) return
    e.preventDefault()
    e.stopPropagation() // don't let the canvas start a draw / the area swallow it
    resizing = handle
    regionBeforeResize = region
    document.addEventListener('mousemove', onResizeMove)
    document.addEventListener('mouseup', onResizeEnd)
  })

  function onResizeMove (e) {
    if (!resizing) return
    var p = eventToPixel(e) // already clamped to image bounds
    // Inclusive edges of the current box; replace only the edges this handle controls.
    var L = region.x; var R = region.x + region.width - 1
    var T = region.y; var B = region.y + region.height - 1
    if (resizing.indexOf('w') !== -1) L = p.x
    if (resizing.indexOf('e') !== -1) R = p.x
    if (resizing.indexOf('n') !== -1) T = p.y
    if (resizing.indexOf('s') !== -1) B = p.y
    // Clamp live to MIN_REGION against the fixed opposite edge — never flip past it.
    if (resizing.indexOf('w') !== -1) L = Math.min(L, R - (MIN_REGION - 1))
    if (resizing.indexOf('e') !== -1) R = Math.max(R, L + (MIN_REGION - 1))
    if (resizing.indexOf('n') !== -1) T = Math.min(T, B - (MIN_REGION - 1))
    if (resizing.indexOf('s') !== -1) B = Math.max(B, T + (MIN_REGION - 1))
    // Edges are already clamped + ordered, so build the rect directly — do NOT route through
    // rectFromPoints (it normalises arbitrary corners, wrong for clamped edges).
    region = { x: L, y: T, width: R - L + 1, height: B - T + 1 }
    positionRegionOverlay() // every frame — keeps x/y in lockstep with the moving edge
    schedulePreview()       // throttled engine re-run (rAF coalesced)
  }

  function onResizeEnd () {
    if (!resizing) return
    document.removeEventListener('mousemove', onResizeMove)
    document.removeEventListener('mouseup', onResizeEnd)
    resizing = null
    regionBeforeResize = null
    renderPreview()  // final, un-throttled paint at the committed bounds
    updateControls()
  }

  // Abort an in-flight resize and restore the pre-drag bounds.
  function cancelResize () {
    if (!resizing) return
    document.removeEventListener('mousemove', onResizeMove)
    document.removeEventListener('mouseup', onResizeEnd)
    region = regionBeforeResize
    resizing = null
    regionBeforeResize = null
    cancelScheduledPreview() // drop any frame queued mid-drag
    positionRegionOverlay()
    renderPreview()
  }

  // Keep the overlay glued to the image when the layout shifts (window resize, or the
  // sidebar scrolling / changing height). No-op until a region exists.
  window.addEventListener('resize', function () { if (region) positionRegionOverlay() })
  sidebar.addEventListener('scroll', function () { if (region) positionRegionOverlay() })

  // ---------------------------------------------------------------------------
  // Picker well display
  // ---------------------------------------------------------------------------
  function setPickedColour (hex) {
    loupe.classList.add('picked')
    loupe.style.setProperty('--picked', hex)
    pickerHex.textContent = hex
    pickerHex.style.color = 'var(--text)' // clear the inline muted placeholder colour
  }

  function resetPickerWell () {
    loupe.classList.remove('picked')
    loupe.style.removeProperty('--picked')
    pickerHex.textContent = 'Click image to pick'
    pickerHex.style.color = 'var(--muted)'
  }

  // ---------------------------------------------------------------------------
  // Replace-colour history (T25)
  // ---------------------------------------------------------------------------
  // localStorage is best-effort: every access is wrapped so private-mode / disabled
  // storage degrades to in-session-only history rather than throwing.
  function loadRecents () {
    var seed = ['#FFFFFF', '#000000'] // first-run seed; white stays default selected
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return seed.slice()
      var arr = JSON.parse(raw)
      if (!Array.isArray(arr) || !arr.length) return seed.slice()
      // Keep only well-formed hex, normalise to uppercase, cap to MAX_RECENT.
      var clean = []
      for (var i = 0; i < arr.length && clean.length < MAX_RECENT; i++) {
        if (typeof arr[i] === 'string' && /^#[0-9a-fA-F]{6}$/.test(arr[i])) {
          clean.push(arr[i].toUpperCase())
        }
      }
      return clean.length ? clean : seed.slice()
    } catch (e) {
      return seed.slice()
    }
  }

  function saveRecents () {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recents))
    } catch (e) { /* storage unavailable — in-memory history still drives the UI */ }
  }

  // Move-to-front + dedupe + cap. Re-picking an existing colour promotes it to slot 1
  // (expected, not a bug — dedupe prevents a duplicate entry).
  function addRecent (hex) {
    hex = hex.toUpperCase()
    recents = recents.filter(function (h) { return h !== hex })
    recents.unshift(hex)
    if (recents.length > MAX_RECENT) recents = recents.slice(0, MAX_RECENT)
  }

  // Rebuild the grid from `recents`, marking the selected swatch. Always called on
  // selection change (cheap at <=5 nodes) so DOM and selectedReplaceHex never desync.
  function renderRecents () {
    while (recentGrid.firstChild) recentGrid.removeChild(recentGrid.firstChild)
    for (var i = 0; i < recents.length; i++) {
      var hex = recents[i]
      var sw = document.createElement('div')
      sw.className = 'recent' + (hex === selectedReplaceHex ? ' selected' : '')
      sw.style.background = hex
      sw.setAttribute('data-hex', hex)
      recentGrid.appendChild(sw)
    }
  }

  function selectReplace (hex) {
    selectedReplaceHex = hex.toUpperCase()
    renderRecents()
    renderPreview() // no-ops until a target colour is picked (renderPreview guard)
  }

  // Swatch selection — delegated on the grid only (the "+" opener lives outside it).
  recentGrid.addEventListener('click', function (e) {
    var sw = e.target.closest ? e.target.closest('.recent') : null
    if (!sw || !recentGrid.contains(sw)) return
    selectReplace(sw.getAttribute('data-hex'))
  })

  // "+" opener — custom popover (T28), replacing the native <input type=color> (Chrome
  // pinned that to the viewport top-left — WORKFLOW-7). A single {h,s,v} draft is the
  // source of truth: the SV box + hue slider write to it; hex (primary) and RGB
  // (secondary) inputs mirror it. The draft is committed to recents ONLY on confirm so
  // dragging doesn't spam history; Esc / outside-click cancels and leaves the prior
  // selection untouched (selectedReplaceHex is never mutated until confirm).
  var pickerPopover = document.getElementById('pickerPopover')
  var pickerSv = document.getElementById('pickerSv')
  var pickerSvThumb = document.getElementById('pickerSvThumb')
  var pickerHue = document.getElementById('pickerHue')
  var pickerHueThumb = document.getElementById('pickerHueThumb')
  var pickerSwatch = document.getElementById('pickerSwatch')
  var pickerHexInput = document.getElementById('pickerHexInput')
  var pickerHexField = pickerHexInput.parentNode
  var pickerR = document.getElementById('pickerR')
  var pickerG = document.getElementById('pickerG')
  var pickerB = document.getElementById('pickerB')
  var pickerCancel = document.getElementById('pickerCancel')
  var pickerConfirm = document.getElementById('pickerConfirm')

  var draft = { h: 0, s: 0, v: 1 } // live picker state while open
  var prevHex = '#FFFFFF'          // selection snapshot, restored on cancel
  var pickerOpen = false

  function clamp01 (n) { return n < 0 ? 0 : (n > 1 ? 1 : n) }
  function clampByte (val) {
    if (val === '' || val == null) return null
    var n = parseInt(val, 10)
    if (isNaN(n)) return null
    return n < 0 ? 0 : (n > 255 ? 255 : n)
  }

  // Push the draft into every control + the preview swatch. `skip` ('hex'|'rgb') leaves
  // the field the user is typing in alone so we don't fight their caret.
  function syncPicker (skip) {
    var rgb = hsvToRgb(draft.h, draft.s, draft.v)
    var hex = rgbToHex(rgb[0], rgb[1], rgb[2])
    var hue = hsvToRgb(draft.h, 1, 1)
    pickerSwatch.style.background = hex
    pickerSv.style.backgroundColor = rgbToHex(hue[0], hue[1], hue[2])
    pickerSvThumb.style.left = (draft.s * 100) + '%'
    pickerSvThumb.style.top = ((1 - draft.v) * 100) + '%'
    pickerHueThumb.style.left = ((draft.h / 360) * 100) + '%'
    if (skip !== 'hex') pickerHexInput.value = hex
    if (skip !== 'rgb') { pickerR.value = rgb[0]; pickerG.value = rgb[1]; pickerB.value = rgb[2] }
    pickerHexField.classList.remove('invalid')
  }

  // Anchor to #paletteBtn: right-aligned, below by default, flipped above near the
  // viewport bottom. position:fixed in CSS, so coords are viewport-relative.
  function positionPicker () {
    var r = paletteBtn.getBoundingClientRect()
    var pw = pickerPopover.offsetWidth
    var ph = pickerPopover.offsetHeight
    var gap = 8
    var left = r.right - pw
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw
    if (left < 8) left = 8
    var top = r.bottom + gap
    if (top + ph > window.innerHeight - 8) top = r.top - gap - ph
    if (top < 8) top = 8
    pickerPopover.style.left = left + 'px'
    pickerPopover.style.top = top + 'px'
  }

  function onOutside (e) {
    if (!pickerPopover.contains(e.target) && e.target !== paletteBtn) cancelPicker()
  }

  function openPicker () {
    prevHex = selectedReplaceHex || '#FFFFFF'
    var rgb = hexToRgb(prevHex)
    draft = rgbToHsv(rgb[0], rgb[1], rgb[2])
    syncPicker()
    pickerPopover.classList.add('open')
    pickerOpen = true
    positionPicker() // measure after display:flex so offsetWidth/Height are real
    // Defer so the opening click's own mousedown doesn't immediately close the popover.
    setTimeout(function () { document.addEventListener('mousedown', onOutside) }, 0)
  }

  function closePicker () {
    pickerPopover.classList.remove('open')
    pickerOpen = false
    document.removeEventListener('mousedown', onOutside)
  }

  // Commit: the one intentional canvas repaint happens here, not during drag.
  function confirmPicker () {
    var rgb = hsvToRgb(draft.h, draft.s, draft.v)
    var hex = rgbToHex(rgb[0], rgb[1], rgb[2])
    addRecent(hex)
    selectedReplaceHex = hex
    saveRecents()
    renderRecents()
    renderPreview()
    closePicker()
  }

  function cancelPicker () {
    selectedReplaceHex = prevHex // explicit restore (untouched in practice — never mutated)
    closePicker()
  }

  // SV box drag — listeners attach to `document` (not the box) so a release OUTSIDE the
  // popover still ends the drag instead of sticking (classic colour-picker bug).
  function svFromEvent (e) {
    var r = pickerSv.getBoundingClientRect()
    draft.s = clamp01((e.clientX - r.left) / r.width)
    draft.v = clamp01(1 - (e.clientY - r.top) / r.height)
    syncPicker()
  }
  function onSvDrag (e) { e.preventDefault(); svFromEvent(e) }
  pickerSv.addEventListener('mousedown', function (e) {
    e.preventDefault()
    svFromEvent(e)
    document.addEventListener('mousemove', onSvDrag)
    document.addEventListener('mouseup', function stop () {
      document.removeEventListener('mousemove', onSvDrag)
      document.removeEventListener('mouseup', stop)
    })
  })

  // Hue slider drag — same document-level pattern.
  function hueFromEvent (e) {
    var r = pickerHue.getBoundingClientRect()
    draft.h = clamp01((e.clientX - r.left) / r.width) * 360
    syncPicker()
  }
  function onHueDrag (e) { e.preventDefault(); hueFromEvent(e) }
  pickerHue.addEventListener('mousedown', function (e) {
    e.preventDefault()
    hueFromEvent(e)
    document.addEventListener('mousemove', onHueDrag)
    document.addEventListener('mouseup', function stop () {
      document.removeEventListener('mousemove', onHueDrag)
      document.removeEventListener('mouseup', stop)
    })
  })

  // Hex field — accepts 3- or 6-digit hex; anything else marks invalid and is ignored.
  pickerHexInput.addEventListener('input', function () {
    var raw = pickerHexInput.value.trim()
    if (!/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw)) { pickerHexField.classList.add('invalid'); return }
    var rgb = hexToRgb(raw)
    draft = rgbToHsv(rgb[0], rgb[1], rgb[2])
    syncPicker('hex')
  })
  // Snap to canonical form on blur (e.g. a 3-digit or partial entry).
  pickerHexInput.addEventListener('blur', function () { syncPicker() })

  // RGB triplet — clamp 0–255; an empty/NaN field is left to finish typing. Fields snap
  // to clamped values on blur so an out-of-range entry doesn't linger.
  function onRgbInput () {
    var r = clampByte(pickerR.value), g = clampByte(pickerG.value), b = clampByte(pickerB.value)
    if (r === null || g === null || b === null) return
    draft = rgbToHsv(r, g, b)
    syncPicker('rgb')
  }
  pickerR.addEventListener('input', onRgbInput)
  pickerG.addEventListener('input', onRgbInput)
  pickerB.addEventListener('input', onRgbInput)
  function onRgbBlur () { syncPicker() }
  pickerR.addEventListener('blur', onRgbBlur)
  pickerG.addEventListener('blur', onRgbBlur)
  pickerB.addEventListener('blur', onRgbBlur)

  pickerConfirm.addEventListener('click', confirmPicker)
  pickerCancel.addEventListener('click', cancelPicker)
  // Enter confirms; Escape is handled by the shared priority chain above.
  document.addEventListener('keydown', function (e) {
    if (pickerOpen && e.key === 'Enter') { e.preventDefault(); confirmPicker() }
  })
  window.addEventListener('resize', function () { if (pickerOpen) positionPicker() })

  // The "+" button toggles the popover (button is a sibling of #recentGrid).
  paletteBtn.addEventListener('click', function () {
    if (pickerOpen) closePicker(); else openPicker()
  })

  // Seed history + paint the initial grid (white selected by default).
  recents = loadRecents()
  selectedReplaceHex = recents[0] || '#FFFFFF'
  renderRecents()

  // Include shades toggle. OFF = exact hex match (tolerance forced to 0, slider muted).
  // ON = slider active, tolerance applied normally. renderPreview() no-ops pre-pick.
  function setIncludeShades (on) {
    includeShades = on
    includeShadeToggle.classList.toggle('on', on)
    includeShadeToggle.setAttribute('aria-checked', on ? 'true' : 'false')
    sliderRow.classList.toggle('muted', !on) // dim + disable slider when exact-match mode
    shadeLabel.textContent = on ? 'Match shades' : 'Exact match'
    shadeSub.textContent = on ? 'Match gradient & anti-aliased variants' : 'Matches only this hex — ignores tolerance'
    renderPreview()
  }
  includeShadeToggle.addEventListener('click', function () { setIncludeShades(!includeShades) })
  includeShadeToggle.addEventListener('keydown', function (e) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setIncludeShades(!includeShades) }
  })
  setIncludeShades(true) // initialise to ON (match shades, slider active)

  // Smart fill toggle (T16). Flip state, reflect it on the switch + ARIA, dim the now-unused
  // replace-colour swatches, and live-update the canvas. renderPreview() no-ops until a
  // target colour is picked (its own guard), so toggling pre-pick is a safe no-op.
  function setSmartFill (on) {
    smartFillOn = on
    smartFillToggle.classList.toggle('on', on)
    smartFillToggle.setAttribute('aria-checked', on ? 'true' : 'false')
    recentRow.classList.toggle('muted', on) // CSS dims + blocks pointer events
    renderPreview()
  }
  smartFillToggle.addEventListener('click', function () { setSmartFill(!smartFillOn) })
  // Keyboard parity for the role=switch (Space/Enter), since it's a div, not a button.
  smartFillToggle.addEventListener('keydown', function (e) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      setSmartFill(!smartFillOn)
    }
  })

  // X-ray view toggle (T29 Phase 1). Adds/removes the `.xray` class on the canvas (a CSS-only
  // contrast filter) and mirrors the pressed state on the glass button. Display-only: nothing else
  // in the pipeline reads the rendered output, so no renderPreview()/commit is needed.
  function setXray (on) {
    xrayOn = on
    canvas.classList.toggle('xray', on)
    xrayBtn.classList.toggle('active', on)
    xrayBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
  xrayBtn.addEventListener('click', function () { setXray(!xrayOn) })
  xrayBtn.addEventListener('keydown', function (e) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setXray(!xrayOn) }
  })

  // Auto-detect watermark (T29 Phase 2). On: run detection on the committed base (honouring any
  // active region) and paint the candidate overlay; report the count in the canvas-hint pill.
  // Off: hide the overlay and restore the hint. Display-only — never mutates pixels.
  function setDetect (on) {
    detectOn = on
    detectBtn.classList.toggle('active', on)
    detectBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
    if (!on) {
      detectOverlay.style.display = 'none'
      restoreDetectHint()
      return
    }
    if (!baseImageData) { setDetect(false); return }
    if (tileOn) setTile(false) // only one canvas overlay at a time (T29 Phase 3, #52)
    // Large-image guard (#43): detection is synchronous and ~O(W·H). Warn FIRST, then defer one
    // tick so the notice actually paints before the main thread freezes on the scan.
    if (canvas.width * canvas.height > DETECT_MAX_PIXELS) {
      setDetectHint('⏳ Large image — detecting, this may pause briefly…', true)
      setTimeout(runDetect, 20)
    } else {
      runDetect()
    }
  }

  // Watermark detection profile (#45). The #45 calibration sweep (scripts/calibrate-detect.js) proved
  // edge-detection + static thresholds CANNOT isolate a faint tiled watermark from photographic
  // content: on the WhatsApp school-photo fixtures the candidates land on faces/uniforms, not the
  // watermark (mask is 2-30% light — see #45 evidence). The real fix is frequency-domain (FFT) tiling
  // detection, tracked in a follow-up ticket. Until then the overlay stays at its pre-#45 behaviour:
  // preContrast:false is passed EXPLICITLY because the #45 buildLut fix made the documented default
  // (true) actually apply — without this the overlay would silently flip to pc=true (a regression).
  var DETECT_PROFILE = { edgeThreshold: 150, preContrast: false }

  function runDetect () {
    if (!detectOn || !baseImageData) return
    var result = Engine.detectWatermark(baseImageData, DETECT_PROFILE, region)
    paintDetectOverlay(result)
    var n = result.components.length
    if (n > 0) setDetectHint('🔎 Found ' + n + ' candidate region' + (n === 1 ? '' : 's') + ' — highlighted (image unchanged)', false)
    else setDetectHint('🔎 No watermark-like text regions found', true)
  }

  // Paint the detected mask (translucent magenta tint) + per-component bounding boxes onto the
  // overlay canvas at IMAGE resolution, then size/position it over #canvas in CSS px.
  function paintDetectOverlay (result) {
    detectOverlay.width = canvas.width
    detectOverlay.height = canvas.height
    var octx = detectOverlay.getContext('2d')
    octx.clearRect(0, 0, canvas.width, canvas.height)
    var mask = result.mask
    var tint = octx.createImageData(canvas.width, canvas.height)
    var td = tint.data
    for (var i = 0; i < mask.length; i++) {
      if (mask[i]) { var o = i * 4; td[o] = 255; td[o + 1] = 0; td[o + 2] = 255; td[o + 3] = 130 }
    }
    octx.putImageData(tint, 0, 0)
    octx.strokeStyle = 'rgba(255,0,255,0.95)'
    octx.lineWidth = Math.max(1, Math.round(canvas.width / 500))
    for (var c = 0; c < result.components.length; c++) {
      var b = result.components[c]
      octx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, (b.x1 - b.x0 + 1) - 1, (b.y1 - b.y0 + 1) - 1)
    }
    positionDetectOverlay()
    detectOverlay.style.display = 'block'
  }

  // Cover #canvas exactly — same maths as positionRegionOverlay, applied to the whole canvas rect
  // so the overlay tracks letterboxing, window resize and sidebar scroll.
  function positionDetectOverlay () {
    if (!detectOn) return
    var cRect = canvas.getBoundingClientRect()
    var aRect = canvasArea.getBoundingClientRect()
    detectOverlay.style.left = (cRect.left - aRect.left) + 'px'
    detectOverlay.style.top = (cRect.top - aRect.top) + 'px'
    detectOverlay.style.width = cRect.width + 'px'
    detectOverlay.style.height = cRect.height + 'px'
  }

  // Hint helpers — kept separate from the smartFill warn pill so the two systems don't fight.
  // warn=true borrows the amber styling (nothing found / heads-up); warn=false is a neutral note.
  function setDetectHint (msg, warn) {
    if (!canvasHint) return
    canvasHint.textContent = msg
    canvasHint.classList.toggle('warn', !!warn)
  }
  function restoreDetectHint () {
    if (!canvasHint) return
    canvasHint.textContent = canvasHintDefault
    canvasHint.classList.remove('warn')
  }

  detectBtn.addEventListener('click', function () { setDetect(!detectOn) })
  detectBtn.addEventListener('keydown', function (e) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setDetect(!detectOn) }
  })
  window.addEventListener('resize', function () { if (detectOn) positionDetectOverlay() })
  sidebar.addEventListener('scroll', function () { if (detectOn) positionDetectOverlay() })

  // ---------------------------------------------------------------------------
  // Tile-fill propagation (T29 Phase 3, #52)
  // ---------------------------------------------------------------------------
  // The user boxes ONE watermark instance with Select area (T17), then Tile-fill detects the tiling
  // lattice (Engine.detectTiling → tileBasis) and stamps the detected seed shape (detectWatermark
  // within the box) across every lattice node (Engine.propagateMask). A confirm overlay previews the
  // propagated union mask (display-only); on Accept the mask is inpainted in one undoable op
  // (Engine.fillMaskRegion). Lifecycle mirrors auto-detect: clears on new image / Reset / Undo /
  // commit / clear-region.
  function setTile (on) {
    tileOn = on
    tileBtn.classList.toggle('active', on)
    tileBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
    if (!on) {
      tileOverlay.style.display = 'none'
      tileConfirm.style.display = 'none'
      tileResult = null
      restoreDetectHint()
      return
    }
    if (!baseImageData) { setTile(false); return }
    // Tile-fill needs a seed: the committed region box around one watermark instance. Turn the
    // button back off, THEN set the hint (setTile(false) calls restoreDetectHint, which would wipe a
    // hint set before it).
    if (!region) {
      setTile(false)
      setDetectHint('▢ Box one watermark instance first (Select area), then Tile-fill', true)
      return
    }
    if (detectOn) setDetect(false) // only one canvas overlay at a time
    // Large-image guard (#43): detectTiling's multi-radius FFT is heavy. Warn FIRST, then defer one
    // tick so the notice paints before the main thread freezes.
    if (canvas.width * canvas.height > TILE_MAX_PIXELS) {
      setDetectHint('⏳ Large image — detecting tiling, this may pause briefly…', true)
      setTimeout(runTile, 20)
    } else {
      runTile()
    }
  }

  function runTile () {
    if (!tileOn || !baseImageData || !region) return
    // Seed shape = the detected watermark glyph(s) inside the user's box (edge-based, colour-agnostic).
    var seed = Engine.detectWatermark(baseImageData, DETECT_PROFILE, region).mask
    var t = Engine.detectTiling(baseImageData, { region: region })
    var prop = Engine.propagateMask(seed, canvas.width, canvas.height, t.tileBasis)
    tileResult = {
      seed: seed,
      propMask: prop.mask,
      instances: prop.instances,
      sub: prop.subharmonicWarning,
      combCount: t.combCount,
      basis: t.tileBasis,
      tileDoubled: false
    }
    paintTileOverlay(prop.mask)
    showTileConfirm(t.combCount, prop.instances, prop.subharmonicWarning)
    restoreDetectHint() // clear the "detecting…" notice — the card now carries the status
  }

  // Paint the propagated union mask as a translucent CYAN tint (distinct from auto-detect's magenta)
  // onto the overlay canvas at IMAGE resolution, then size/position it over #canvas in CSS px.
  function paintTileOverlay (mask) {
    tileOverlay.width = canvas.width
    tileOverlay.height = canvas.height
    var octx = tileOverlay.getContext('2d')
    octx.clearRect(0, 0, canvas.width, canvas.height)
    var tint = octx.createImageData(canvas.width, canvas.height)
    var td = tint.data
    for (var i = 0; i < mask.length; i++) {
      if (mask[i]) { var o = i * 4; td[o] = 0; td[o + 1] = 200; td[o + 2] = 255; td[o + 3] = 120 }
    }
    octx.putImageData(tint, 0, 0)
    positionTileOverlay()
    tileOverlay.style.display = 'block'
  }

  // Cover #canvas exactly — same rect maths as positionDetectOverlay, so the overlay tracks
  // letterboxing / portrait images (sx===sy, CORE-10), window resize and sidebar scroll.
  function positionTileOverlay () {
    if (!tileOn) return
    var cRect = canvas.getBoundingClientRect()
    var aRect = canvasArea.getBoundingClientRect()
    tileOverlay.style.left = (cRect.left - aRect.left) + 'px'
    tileOverlay.style.top = (cRect.top - aRect.top) + 'px'
    tileOverlay.style.width = cRect.width + 'px'
    tileOverlay.style.height = cRect.height + 'px'
  }

  // Confirm card: instance-count pill + confidence band (HARD requirement, #52). The band is driven
  // by combCount, NOT a binary tiling flag — WhatsApp .19 (a real target) sits at combCount=5, exactly
  // at the detection gate, so a true/false pill would hide false negatives (LEARNINGS #50/#51).
  function showTileConfirm (combCount, instances, sub) {
    tileCount.textContent = 'Found ' + instances + ' instance' + (instances === 1 ? '' : 's')
    if (combCount >= 6) {
      tileBand.textContent = 'Strong tiling signal'
      tileBand.classList.remove('warn')
    } else if (combCount === 5) {
      tileBand.textContent = 'Weak tiling signal — some instances may be missed'
      tileBand.classList.add('warn')
    } else {
      tileBand.textContent = 'Not detected by current threshold'
      tileBand.classList.add('warn')
    }
    // Subharmonic recovery chip (HARD requirement, #52). propagateMask flags a half-period lock when
    // the basis is shorter than the seed footprint — stamps overlap impossibly. The chip lets the user
    // double the spacing in one click (onSubchip). Hidden when there is no lock.
    if (sub) {
      tileSubchip.textContent = '⤢ Tile spacing looks halved — double it?'
      tileSubchip.disabled = false
      tileSubchip.style.display = 'block'
    } else {
      tileSubchip.style.display = 'none'
    }
    tileConfirm.style.display = 'flex'
  }

  // Subharmonic "double the spacing" action (#52). Re-propagate with a 2×-scaled basis: longer
  // vectors → a coarser lattice with FEWER (≈half in 1-D) nodes, removing the overlapping half-period
  // stamps — so the instance count DROPS (that is the success signal). Upper-bounded: we never offer a
  // SECOND doubling — if the lock persists the chip becomes a non-actionable note so the user can't
  // loop into repeated overshoots.
  function onSubchip () {
    if (!tileResult || tileSubchip.disabled) return
    var basis2x = tileResult.basis.map(function (v) { return { x: v.x * 2, y: v.y * 2 } })
    var prop2 = Engine.propagateMask(tileResult.seed, canvas.width, canvas.height, basis2x)
    tileResult.propMask = prop2.mask
    tileResult.instances = prop2.instances
    tileResult.sub = prop2.subharmonicWarning
    tileResult.basis = basis2x
    tileResult.tileDoubled = true // basis no longer matches raw detectTiling — block stale reuse
    paintTileOverlay(prop2.mask)
    tileCount.textContent = 'Found ' + prop2.instances + ' instance' + (prop2.instances === 1 ? '' : 's')
    if (prop2.subharmonicWarning) {
      // Still locked after one doubling — stop here (no infinite 2× loop).
      tileSubchip.textContent = '⤢ Spacing still looks off — accept or re-box'
      tileSubchip.disabled = true
    } else {
      tileSubchip.style.display = 'none'
    }
  }

  // Accept: inpaint the propagated mask and commit as a single undoable op. NOTE: we deliberately do
  // NOT call commitOperation() here — it early-returns when targetRgb is null (tile-fill has no picked
  // colour), which would silently drop the undo snapshot. So we snapshot the undo entry directly,
  // exactly as commitOperation does. Do NOT "simplify" this back to commitOperation().
  function acceptTile () {
    if (!tileResult || !baseImageData) return
    var work = new ImageData(
      new Uint8ClampedArray(baseImageData.data),
      canvas.width,
      canvas.height
    )
    // region:null → the #31 guard denominator is the whole image (thin tiled strokes stay well under
    // the ratio). dilate:1 reconstructs anti-aliased edges (T30) — bump to 2 if QA shows a 1px halo.
    var r = Engine.fillMaskRegion(work, tileResult.propMask, { dilate: 1, maxFillRatio: 0.8 }, null)
    if (r && r.skipped) {
      showHintWarning('⚠ Tile-fill skipped — too much of the image matches. Re-box a tighter instance.')
      return // leave the canvas + base untouched; nothing committed
    }
    if (!r || r.filled === 0) {
      showHintWarning('⚠ Nothing to fill — no watermark shape detected in the box.')
      return
    }
    ctx.putImageData(work, 0, 0)
    // Commit directly (see note above): push the pre-fill base, cap history, snapshot the new base.
    undoStack.push(baseImageData)
    if (undoStack.length > MAX_UNDO) undoStack.shift()
    baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    livePreviewImageData = null
    if (detectOn) setDetect(false) // a fill invalidates any auto-detect snapshot
    setTile(false) // hide overlay + card; clears tileResult
    updateControls() // a recolour now exists -> undo + before/after enabled
  }

  function cancelTile () {
    setTile(false) // hide overlay + card, clear tileResult; the seed region box stays
  }

  tileBtn.addEventListener('click', function () { setTile(!tileOn) })
  tileBtn.addEventListener('keydown', function (e) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setTile(!tileOn) }
  })
  tileAccept.addEventListener('click', acceptTile)
  tileCancel.addEventListener('click', cancelTile)
  tileSubchip.addEventListener('click', onSubchip)
  window.addEventListener('resize', function () { if (tileOn) positionTileOverlay() })
  sidebar.addEventListener('scroll', function () { if (tileOn) positionTileOverlay() })

  // ---------------------------------------------------------------------------
  // Preview (one-shot, on pick) + reset
  // ---------------------------------------------------------------------------
  function selectedReplaceRgb () {
    return hexToRgb(selectedReplaceHex || '#FFFFFF')
  }

  function renderPreview () {
    if (!baseImageData || !targetRgb) return
    var tol = includeShades ? parseInt(tolerance.value, 10) : 0
    // Start from a fresh copy of the committed base (NOT the original) so this op
    // stacks on top of prior committed ops (T26). The engine mutates in place; the
    // copy keeps baseImageData / undoStack snapshots pristine.
    var work = new ImageData(
      new Uint8ClampedArray(baseImageData.data),
      canvas.width,
      canvas.height
    )
    // Smart fill (T16/T42) reconstructs matched pixels from their neighbours and ignores the
    // selected replace colour; the flat path overwrites them with it. `region` (T17) is null
    // for whole-image and constrains both paths to the drawn box when set. `dilate: 1` (T30)
    // expands the mask 1px so anti-aliased watermark edges are reconstructed, not left as a halo.
    // `maxFillRatio: 0.8` (T42/#31) skips the fill when nearly the whole image matches — the result
    // would be garbage and the work can stall the main thread into a render glitch.
    if (smartFillOn) {
      var r = Engine.smartFill(work, targetRgb, tol, { dilate: 1, maxFillRatio: 0.8 }, region)
      if (r && r.skipped) {
        // Too much of the image matches: leave the canvas on its prior (committed) state and warn.
        // `work` is an untouched copy of baseImageData, so painting it is a safe no-op repaint.
        showHintWarning('⚠ Smart fill skipped — too much of the image matches. Lower the tolerance.')
        ctx.putImageData(work, 0, 0)
        livePreviewImageData = work
        return
      }
      clearHintWarning()
    } else {
      clearHintWarning()
      Engine.replaceColour(work, targetRgb, selectedReplaceRgb(), tol, region)
    }
    ctx.putImageData(work, 0, 0)
    livePreviewImageData = work // loupe reads this so it shows the in-progress result
  }

  // The #31 guard surfaces through the existing .canvas-hint pill (no toast system in this app):
  // cache the default instruction text once, swap in a warning, and restore on the next clean render.
  function showHintWarning (msg) {
    if (!canvasHint) return
    canvasHint.textContent = msg
    canvasHint.classList.add('warn')
  }
  function clearHintWarning () {
    if (!canvasHint || !canvasHint.classList.contains('warn')) return
    canvasHint.textContent = canvasHintDefault
    canvasHint.classList.remove('warn')
  }

  // ---------------------------------------------------------------------------
  // Undo / multi-pass history (T26)
  // ---------------------------------------------------------------------------
  // Bake the current live preview into the committed base, pushing the old base onto
  // the undo stack. No-op when no colour is picked (nothing live to commit).
  function commitOperation () {
    if (detectOn) setDetect(false) // an edit invalidates the auto-detect snapshot (T29 Phase 2)
    if (tileOn) setTile(false) // …and the tile-fill propagation preview (T29 Phase 3, #52)
    if (!targetRgb) return
    undoStack.push(baseImageData)
    if (undoStack.length > MAX_UNDO) undoStack.shift() // push first, then drop oldest
    // The live preview is already painted on the canvas -> snapshot it as the new base.
    baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    livePreviewImageData = null // baseImageData now IS the former preview; no separate cache needed
  }

  // Step back one change. Two cases: a live (uncommitted) op is discarded first;
  // otherwise the last committed base is popped. Never drains the stack on a live op.
  function undo () {
    if (!originalImageData) return
    cancelScheduledPreview() // drop any frame queued from a mid-drag slider move
    if (detectOn) setDetect(false) // the overlay is stale once the canvas content changes (T29 Phase 2)
    if (tileOn) setTile(false) // tile-fill preview is stale once the canvas content changes (#52)
    if (targetRgb) {
      // Discard the live, uncommitted op -> repaint the committed base.
      targetRgb = null
      livePreviewImageData = null // stale preview no longer valid — loupe reads baseImageData
      ctx.putImageData(baseImageData, 0, 0)
      disarmPicker()
      resetPickerWell()
    } else if (undoStack.length) {
      baseImageData = undoStack.pop()
      ctx.putImageData(baseImageData, 0, 0)
    }
    updateControls()
  }

  // Single source of truth for the controls gated on "are there edits to undo / compare".
  // When undoStack is empty and no op is live, baseImageData === original, so both the
  // undo button and the before/after trigger are correctly disabled.
  function updateControls () {
    var hasEdits = targetRgb !== null || undoStack.length > 0
    undoBtn.disabled = !hasEdits
    baBtn.disabled = !hasEdits
  }

  // Live re-scan throttle (T18). Each renderPreview() copies the full image and
  // does an O(W·H) LAB scan; the slider's `input` event fires rapidly on drag, so
  // coalesce to at most one render per animation frame using the latest value.
  var previewQueued = false
  var previewRafId = null
  function schedulePreview () {
    if (previewQueued) return
    previewQueued = true
    previewRafId = requestAnimationFrame(function () {
      previewQueued = false
      previewRafId = null
      renderPreview()
    })
  }

  // Drop any frame queued from a mid-drag slider move. Called when the underlying
  // state is invalidated (Reset, new image) so a stale render can't fire after.
  function cancelScheduledPreview () {
    if (previewRafId) cancelAnimationFrame(previewRafId)
    previewQueued = false
    previewRafId = null
  }

  resetBtn.addEventListener('click', function () {
    if (!originalImageData) return
    cancelScheduledPreview() // drop any frame queued from a mid-drag slider move
    ctx.putImageData(originalImageData, 0, 0)
    // Nuke all history AND any live op (T26) — Reset returns fully to the original.
    baseImageData = new ImageData(
      new Uint8ClampedArray(originalImageData.data),
      canvas.width,
      canvas.height
    )
    undoStack = []
    targetRgb = null
    livePreviewImageData = null // preview invalidated by reset
    region = null // Reset returns to whole-image (T17)
    regionRect.style.display = 'none'
    disarmPicker()
    exitSelecting()
    setXray(false) // Reset returns to the normal (un-enhanced) view (T29)
    setDetect(false) // clear any auto-detect overlay (T29 Phase 2)
    setTile(false) // clear any tile-fill propagation overlay (T29 Phase 3, #52)
    resetPickerWell()
    updateControls() // back to the original -> undo + before/after disabled
  })

  undoBtn.addEventListener('click', undo)

  // Keep the value label in sync and live re-scan as the slider drags (T18).
  // schedulePreview() no-ops until a colour is picked (renderPreview guard).
  tolerance.addEventListener('input', function () {
    tolVal.textContent = tolerance.value
    schedulePreview()
  })

  // ---------------------------------------------------------------------------
  // Before/after modal (T24)
  // ---------------------------------------------------------------------------
  // The trigger is disabled until a colour is picked (gated by updateControls() via
  // hasEdits), so the modal never opens with two identical images.
  function openModal () {
    if (!originalImageData) return
    baBefore.src = originalSrc
    // After = current canvas pixels (the live preview). Captured as a Blob object
    // URL rather than a data URL: toDataURL serialises the whole image into an
    // in-memory string (perf + src length-limit risk on big images, plus a known
    // re-assignment leak). Snapshot is at open-time — slider drags while the modal
    // is open won't update it; close + reopen to refresh.
    canvas.toBlob(function (blob) {
      if (baAfter._blobUrl) URL.revokeObjectURL(baAfter._blobUrl)
      baAfter._blobUrl = URL.createObjectURL(blob)
      baAfter.src = baAfter._blobUrl
    }, 'image/png')
    modal.classList.add('open')
  }

  function closeModal () {
    modal.classList.remove('open')
    if (baAfter._blobUrl) {
      URL.revokeObjectURL(baAfter._blobUrl)
      baAfter._blobUrl = null
    }
  }

  baBtn.addEventListener('click', openModal)
  modalClose.addEventListener('click', closeModal)
  // Backdrop click closes; clicks on the inner .modal don't match (no handler there).
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal()
  })
})()
