/**
 * Regression check for three timeline fixes:
 *
 *   1. Clicking a clip must select it *visibly* — the selection outline lives
 *      on the static canvas layer, so the layer has to be repainted when the
 *      selection changes.
 *   2. Video and audio tracks must not be capped at 2 + 1.
 *   3. Zooming must repaint the filmstrips and waveforms immediately, without
 *      waiting for a drag to force a redraw.
 *
 * The static timeline canvas is tainted by the `clipforge://` thumbnails, so
 * its pixels cannot be read back. Instead the script instruments the 2D
 * context of that canvas and records what was drawn — the selection outline,
 * the filmstrip blits and the waveform path — which is exactly what the user
 * ends up seeing.
 *
 *   npx electron scripts/verify.cjs
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'shots')
const MEDIA = [
  path.join(ROOT, 'testmedia', 'clip-a.mp4'),
  path.join(ROOT, 'testmedia', 'clip-b.mp4'),
  path.join(ROOT, 'testmedia', 'music.m4a')
]

/** The video clip under test lives on the second lane ("视频 1"). */
const CLIP_TRACK_INDEX = 1
const RULER_H = 26
const TRACK_H = 62

const SIGNAL = '#3fd9c0'
const AUDIO = '#9b87f5'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function shot(win, name) {
  const image = await win.capturePage()
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG())
}

/**
 * Instruments the static timeline canvas and starts recording. Everything
 * the timeline paints on that canvas shows up in `window.__probe`.
 */
const INSTALL_PROBE = `(() => {
  const canvas = document.querySelector('canvas.timeline__canvas:not(.timeline__canvas--dynamic)')
  if (!canvas) return { error: 'no static timeline canvas' }
  const ctx = canvas.getContext('2d')
  const probe = { strokes: [], blits: [], segments: 0 }
  window.__probe = probe

  const origLineTo = ctx.lineTo.bind(ctx)
  ctx.lineTo = function (...args) {
    probe.segments++
    return origLineTo(...args)
  }
  const origStroke = ctx.stroke.bind(ctx)
  ctx.stroke = function (...args) {
    probe.strokes.push({ style: ctx.strokeStyle, segments: probe.segments })
    probe.segments = 0
    return origStroke(...args)
  }
  const origDrawImage = ctx.drawImage.bind(ctx)
  ctx.drawImage = function (...args) {
    // drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
    probe.blits.push({ dx: args[5], dy: args[6], dw: args[7], dh: args[8] })
    return origDrawImage(...args)
  }
  return { ok: true }
})()`

/** Returns the probe's counters and resets them. */
const READ_PROBE = `(() => {
  const p = window.__probe
  if (!p) return { error: 'no probe' }
  const out = {
    strokes: p.strokes.slice(),
    blits: p.blits.slice(),
    strokeCount: p.strokes.length,
    blitCount: p.blits.length
  }
  p.strokes.length = 0
  p.blits.length = 0
  return out
})()`

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true })
  require(path.join(ROOT, 'out', 'main', 'index.js'))

  await app.whenReady()
  await delay(2500)

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.error('no window was created')
    app.exit(1)
  }

  /* --- set up a timeline --------------------------------------------- */
  console.log('\n▶ setting up a timeline')
  await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      store.getState().addAssets(assets)
      const s = store.getState()
      s.insertClip(assets[0].id, 't_video_1', 2)
      s.insertClip(assets[2].id, 't_audio_1', 0)
      return true
    })()`
  )

  // Wait for the sprite sheet and the waveform to land, and for the sprite
  // images to finish decoding — otherwise the cache keeps notifying and
  // repainting the timeline in the middle of a measurement.
  await win.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 25000
      const ids = Object.keys(window.__clipforgeEditor.getState().project.assets)
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 300))
        const sprites = ids.filter(id => window.__clipforgeMedia.sprite(id)).length
        const waves = ids.filter(id => window.__clipforgeMedia.waveform(id)).length
        const decoded = ids.every(id => {
          const sheet = window.__clipforgeMedia.sprite(id)
          if (!sheet) return true
          const img = window.__clipforgeMedia.image(sheet.url)
          return img && img.complete && img.naturalWidth > 0
        })
        if (sprites >= 2 && waves >= 1 && decoded) return true
      }
      return false
    })()`
  )
  await delay(1500)

  const setup = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const clip = s.project.tracks.find(t => t.id === 't_video_1').clips[0]
      const audioClip = s.project.tracks.find(t => t.id === 't_audio_1').clips[0]
      const scroller = document.querySelector('.timeline__scroller')
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      const rect = canvas.getBoundingClientRect()
      return {
        clipId: clip.id,
        start: clip.start,
        duration: clip.duration,
        audioDuration: audioClip.duration,
        pxPerSecond: s.pxPerSecond,
        scrollLeft: scroller.scrollLeft,
        // 60px into the clip, on the "视频 1" lane.
        screenX: rect.left + clip.start * s.pxPerSecond - scroller.scrollLeft + 60,
        screenY: rect.top + ${RULER_H + CLIP_TRACK_INDEX * TRACK_H} + 30
      }
    })()`
  )
  console.log(`  clip ${setup.duration.toFixed(2)}s at ${setup.start}s`)

  const probe = await win.webContents.executeJavaScript(INSTALL_PROBE)
  if (probe.error) {
    console.error(probe.error)
    app.exit(1)
  }
  await delay(120)
  await win.webContents.executeJavaScript(READ_PROBE) // discard the setup paints

  /* --- 1. clicking selects -------------------------------------------- */
  console.log('\n▶ click to select')
  win.webContents.sendInputEvent({ type: 'mouseMove', x: setup.screenX, y: setup.screenY })
  win.webContents.sendInputEvent({
    type: 'mouseDown', x: setup.screenX, y: setup.screenY, button: 'left', clickCount: 1
  })
  await delay(60)
  win.webContents.sendInputEvent({
    type: 'mouseUp', x: setup.screenX, y: setup.screenY, button: 'left', clickCount: 1
  })
  await delay(400)

  const selected = await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().selectedClipIds`
  )
  check('a click selects the clip in the store', selected.includes(setup.clipId), selected.join(','))

  const clickPaint = await win.webContents.executeJavaScript(READ_PROBE)
  const selectionStrokes = clickPaint.strokes.filter((s) => s.style === SIGNAL)
  check(
    'the click repaints the static layer with a selection outline',
    selectionStrokes.length > 0,
    `${selectionStrokes.length} outline stroke(s)`
  )
  await shot(win, '06-click-select')

  /* --- 3. zoom repaints the filmstrip --------------------------------- */
  console.log('\n▶ zoom repaints the timeline')
  const zoom = await win.webContents.executeJavaScript(
    `(() => {
      const store = window.__clipforgeEditor
      const s = store.getState()
      const clip = s.project.tracks.find(t => t.id === 't_video_1').clips[0]
      const audioClip = s.project.tracks.find(t => t.id === 't_audio_1').clips[0]
      const scroller = document.querySelector('.timeline__scroller')
      store.getState().setZoom(200)
      return {
        clipStart: clip.start,
        clipDuration: clip.duration,
        audioDuration: audioClip.duration,
        scrollLeft: scroller.scrollLeft
      }
    })()`
  )
  await delay(500)

  const zoomPaint = await win.webContents.executeJavaScript(READ_PROBE)
  check(
    'the zoom repaints the static layer',
    zoomPaint.blitCount > 0,
    `${zoomPaint.blitCount} filmstrip blit(s)`
  )

  // The filmstrip has to be laid out at the new scale: the last blit of the
  // strip ends at (start + duration) * pxPerSecond.
  const stripEnd = zoomPaint.blits.reduce(
    (max, b) => Math.max(max, b.dx + b.dw),
    -Infinity
  )
  const expectedEnd =
    (zoom.clipStart + zoom.clipDuration) * 200 - zoom.scrollLeft
  check(
    'the filmstrip follows the new zoom',
    Math.abs(stripEnd - expectedEnd) < 12,
    `strip ends at ${stripEnd.toFixed(0)}px, expected ${expectedEnd.toFixed(0)}px`
  )

  // The waveform is one stroke per column, so its segment count is the
  // width of the clip in pixels.
  const waveStrokes = zoomPaint.strokes.filter((s) => s.style === AUDIO)
  const waveColumns = waveStrokes.reduce((max, s) => Math.max(max, s.segments), 0)
  const expectedColumns = Math.floor(zoom.audioDuration * 200)
  check(
    'the waveform follows the new zoom',
    waveStrokes.length > 0 && Math.abs(waveColumns - expectedColumns) < 8,
    `${waveColumns} columns, expected ${expectedColumns}`
  )
  await shot(win, '07-zoomed')

  /* --- 2. unlimited tracks -------------------------------------------- */
  console.log('\n▶ unlimited tracks')
  const trackState = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const before = store.getState().project.tracks.length
      // Drive the real UI buttons, not the store.
      const buttons = document.querySelectorAll('.timeline__head-add')
      buttons[0].click()
      buttons[1].click()
      buttons[1].click()
      // Let React flush the re-render before the DOM is inspected.
      await new Promise(r => setTimeout(r, 250))
      const after = store.getState().project.tracks
      return {
        before,
        after: after.length,
        kinds: after.map(t => t.kind),
        names: after.map(t => t.name),
        heads: document.querySelectorAll('.track-head').length
      }
    })()`
  )
  check(
    'the add-track buttons create tracks',
    trackState.after === trackState.before + 3,
    `${trackState.before} → ${trackState.after} (${trackState.kinds.join(', ')})`
  )
  check(
    'every track gets a header',
    trackState.heads === trackState.after,
    `${trackState.heads} headers for ${trackState.after} tracks`
  )
  check(
    'track names are unique',
    new Set(trackState.names).size === trackState.names.length,
    trackState.names.join(', ')
  )

  const removed = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const before = store.getState().project.tracks.length
      const heads = document.querySelectorAll('.track-head')
      heads[heads.length - 1].querySelector('.track-head__remove').click()
      await new Promise(r => setTimeout(r, 250))
      return {
        before,
        after: store.getState().project.tracks.length,
        heads: document.querySelectorAll('.track-head').length
      }
    })()`
  )
  check(
    'a track can be removed again',
    removed.after === removed.before - 1 && removed.heads === removed.after,
    `${removed.before} → ${removed.after}`
  )

  await delay(400)
  await shot(win, '08-tracks')

  /* --- the track headers follow the timeline scroll -------------------- */
  console.log('\n▶ track headers stay aligned with the lanes')
  const sync = await win.webContents.executeJavaScript(
    `(async () => {
      const scroller = document.querySelector('.timeline__scroller')
      const heads = document.querySelector('.timeline__head-list')
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      scroller.scrollTop = 90
      await new Promise(r => setTimeout(r, 300))
      const canvasRect = canvas.getBoundingClientRect()
      const rows = [...document.querySelectorAll('.track-head')]
      const drift = rows.map((row, i) => {
        const expected = canvasRect.top + ${RULER_H} + i * ${TRACK_H} - scroller.scrollTop
        return Math.round(row.getBoundingClientRect().top - expected)
      })
      return {
        headScrollTop: heads.scrollTop,
        scrollerScrollTop: scroller.scrollTop,
        drift,
        tracks: rows.length
      }
    })()`
  )
  check(
    'the header column scrolls with the timeline',
    Math.abs(sync.headScrollTop - sync.scrollerScrollTop) < 1,
    `heads ${sync.headScrollTop} vs canvas ${sync.scrollerScrollTop}`
  )
  check(
    'every header lines up with its lane',
    sync.drift.every((d) => Math.abs(d) <= 1),
    `drift ${sync.drift.join(', ')}px`
  )
  await shot(win, '09-scrolled')

  /* --- media still lands when every track is gone --------------------- */
  console.log('\n▶ dropping media with no tracks left')
  const empty = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      for (const track of [...store.getState().project.tracks]) {
        store.getState().removeTrack(track.id)
      }
      await new Promise(r => setTimeout(r, 200))
      const before = store.getState().project.tracks.length

      const assetId = Object.keys(store.getState().project.assets)[0]
      const scroller = document.querySelector('.timeline__scroller')
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      const rect = canvas.getBoundingClientRect()
      const data = new DataTransfer()
      data.setData('application/x-clipforge-asset', assetId)
      scroller.dispatchEvent(new DragEvent('drop', {
        dataTransfer: data,
        clientX: rect.left + 120,
        clientY: rect.top + 60,
        bubbles: true,
        cancelable: true
      }))
      await new Promise(r => setTimeout(r, 300))
      const s = store.getState()
      return {
        before,
        after: s.project.tracks.length,
        clips: s.project.tracks.reduce((n, t) => n + t.clips.length, 0)
      }
    })()`
  )
  check(
    'dropping media recreates a track to hold it',
    empty.after === empty.before + 1 && empty.clips === 1,
    `${empty.before} → ${empty.after} tracks, ${empty.clips} clip(s)`
  )

  console.log(failures === 0 ? '\n✅ all checks passed' : `\n❌ ${failures} check(s) failed`)
  app.exit(failures === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  app.exit(1)
})
