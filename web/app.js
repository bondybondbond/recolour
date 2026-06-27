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
  var resetBtn = document.getElementById('resetBtn')
  var undoBtn = document.getElementById('undoBtn')
  var canvasArea = canvas.parentNode

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

  // Smart fill (T16). When on, renderPreview() uses Engine.smartFill() — cardinal
  // distance-weighted interpolation — instead of the flat selected replace colour.
  // Each matched pixel is reconstructed from the nearest original background pixel in
  // each of the 4 cardinal directions, weighted by 1/distance. The Panel 2 swatches are
  // dimmed + disabled while it's active because the flat colour is not used.
  var smartFillOn = false

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

  // Floating magnifier (created lazily on first load).
  var MAG_RADIUS = 4           // 4 px each side of centre -> 9x9 grid
  var MAG_ZOOM = 14            // on-screen px per source px
  var MAG_PX = (MAG_RADIUS * 2 + 1) * MAG_ZOOM // 126px square
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
    region = null // a new image drops any prior selection (T17)
    regionRect.style.display = 'none'
    disarmPicker()
    exitSelecting()
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
    var d = baseImageData.data
    var i = (y * canvas.width + x) * 4
    return [d[i], d[i + 1], d[i + 2], d[i + 3]]
  }

  // Draw the 9x9 neighbourhood around (cx,cy) into the floating loupe, zoomed,
  // with a pixel grid and crosshair on the centre cell.
  function drawMagnifier (e, cx, cy) {
    magCtx.clearRect(0, 0, MAG_PX, MAG_PX)
    var d = baseImageData.data // committed state — shows filled colours, not the original
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

    // Position: above-right of the cursor by default so the work area stays visible.
    // Falls back to below-right if not enough space above; flips left if near right edge.
    var rect = canvasArea.getBoundingClientRect()
    var cx2 = e.clientX - rect.left
    var cy2 = e.clientY - rect.top
    var left = cx2 + 18
    var top = cy2 - MAG_PX - 18          // prefer above cursor
    if (top < 0) top = cy2 + 18           // fall below if too close to top
    if (left + MAG_PX > rect.width) left = cx2 - MAG_PX - 18  // flip left if near right edge
    magCanvas.style.left = left + 'px'
    magCanvas.style.top = top + 'px'
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
      if (modal.classList.contains('open')) closeModal()
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

  // "+" opener — its own listener (button is a sibling of #recentGrid). Lazily creates
  // a hidden <input type=color>; the picked colour is added to history and selected.
  // NOTE: programmatic .click() works on all desktop browsers; iOS Safari blocks it on
  // colour inputs (known WebKit limit) — out of scope for this desktop-first tool.
  var colorInput = null
  paletteBtn.addEventListener('click', function () {
    if (!colorInput) {
      colorInput = document.createElement('input')
      colorInput.type = 'color'
      colorInput.style.display = 'none'
      document.body.appendChild(colorInput)
      colorInput.addEventListener('input', function () {
        var hex = colorInput.value.toUpperCase()
        addRecent(hex)
        selectedReplaceHex = hex
        saveRecents()
        renderRecents()
        renderPreview()
      })
    }
    colorInput.value = selectedReplaceHex.toLowerCase() // <input type=color> wants lowercase
    colorInput.click()
  })

  // Seed history + paint the initial grid (white selected by default).
  recents = loadRecents()
  selectedReplaceHex = recents[0] || '#FFFFFF'
  renderRecents()

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

  // ---------------------------------------------------------------------------
  // Preview (one-shot, on pick) + reset
  // ---------------------------------------------------------------------------
  function selectedReplaceRgb () {
    return hexToRgb(selectedReplaceHex || '#FFFFFF')
  }

  function renderPreview () {
    if (!baseImageData || !targetRgb) return
    var tol = parseInt(tolerance.value, 10)
    // Start from a fresh copy of the committed base (NOT the original) so this op
    // stacks on top of prior committed ops (T26). The engine mutates in place; the
    // copy keeps baseImageData / undoStack snapshots pristine.
    var work = new ImageData(
      new Uint8ClampedArray(baseImageData.data),
      canvas.width,
      canvas.height
    )
    // Smart fill (T16) reconstructs matched pixels from their neighbours and ignores the
    // selected replace colour; the flat path overwrites them with it. `region` (T17) is null
    // for whole-image and constrains both paths to the drawn box when set.
    if (smartFillOn) Engine.smartFill(work, targetRgb, tol, undefined, region)
    else Engine.replaceColour(work, targetRgb, selectedReplaceRgb(), tol, region)
    ctx.putImageData(work, 0, 0)
  }

  // ---------------------------------------------------------------------------
  // Undo / multi-pass history (T26)
  // ---------------------------------------------------------------------------
  // Bake the current live preview into the committed base, pushing the old base onto
  // the undo stack. No-op when no colour is picked (nothing live to commit).
  function commitOperation () {
    if (!targetRgb) return
    undoStack.push(baseImageData)
    if (undoStack.length > MAX_UNDO) undoStack.shift() // push first, then drop oldest
    // The live preview is already painted on the canvas -> snapshot it as the new base.
    baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  }

  // Step back one change. Two cases: a live (uncommitted) op is discarded first;
  // otherwise the last committed base is popped. Never drains the stack on a live op.
  function undo () {
    if (!originalImageData) return
    cancelScheduledPreview() // drop any frame queued from a mid-drag slider move
    if (targetRgb) {
      // Discard the live, uncommitted op -> repaint the committed base.
      targetRgb = null
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
    region = null // Reset returns to whole-image (T17)
    regionRect.style.display = 'none'
    disarmPicker()
    exitSelecting()
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
