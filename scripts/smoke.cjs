/**
 * End-to-end smoke test.
 *
 * Boots the built app, imports real media, builds a timeline, waits for the
 * thumbnails and waveforms to arrive, exercises playback, runs an export and
 * captures screenshots along the way.
 *
 *   npx electron scripts/smoke.cjs
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(win, name) {
  const image = await win.capturePage()
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG())
  console.log(`  📸 ${name}.png`)
}

function fail(message) {
  console.error(`\n❌ ${message}\n`)
  app.exit(1)
}

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true })

  // Boots the real application (window, protocol, IPC handlers).
  require(path.join(ROOT, 'out', 'main', 'index.js'))

  await app.whenReady()
  await delay(2500)

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return fail('no window was created')

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message)
  })

  /* --- import + build a timeline ------------------------------------- */
  console.log('\n▶ importing media')
  const imported = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      if (!assets.length) return { error: 'no assets imported' }
      store.getState().pushHistory()
      store.getState().addAssets(assets)
      const s = store.getState()
      s.insertClip(assets[0].id, 't_video_1', 0)
      s.insertClip(assets[1].id, 't_video_1', 8)
      s.insertClip(assets[2].id, 't_audio_1', 0)
      store.getState().setPlayhead(2.5)
      return { count: assets.length, names: assets.map(a => a.name + ' ' + a.duration.toFixed(2) + 's') }
    })()`
  )

  if (imported.error) return fail(imported.error)
  console.log(`  imported ${imported.count}: ${imported.names.join(', ')}`)

  /* --- wait for thumbnails + waveforms -------------------------------- */
  console.log('\n▶ waiting for media cache')
  const cache = await win.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 25000
      const ids = Object.keys(window.__clipforgeEditor.getState().project.assets)
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 300))
        const sprites = ids.filter(id => window.__clipforgeMedia.sprite(id)).length
        const waves = ids.filter(id => window.__clipforgeMedia.waveform(id)).length
        if (sprites >= 2 && waves >= 1) return { sprites, waves, total: ids.length }
      }
      return {
        sprites: ids.filter(id => window.__clipforgeMedia.sprite(id)).length,
        waves: ids.filter(id => window.__clipforgeMedia.waveform(id)).length,
        total: ids.length,
        timedOut: true
      }
    })()`
  )
  console.log(`  sprites=${cache.sprites}/${cache.total} waveforms=${cache.waves}/${cache.total}`)
  if (cache.timedOut) console.warn('  ⚠ media cache did not fill in time')

  await delay(1200)
  await shot(win, '01-timeline')

  /* --- the preview must actually show a frame -------------------------- */
  // The picture appears as soon as the video element has a frame to show,
  // which can take a moment on a cold cache.
  const preview = await win.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 15000
      let last = null
      while (Date.now() < deadline) {
        const c = document.querySelector('canvas.preview__canvas')
        if (!c) return { error: 'no preview canvas' }
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        const seen = new Set()
        for (let i = 0; i < d.length; i += 4 * 977) seen.add(d[i] + ',' + d[i+1] + ',' + d[i+2])
        last = { width: c.width, height: c.height, distinctColors: seen.size }
        if (last.distinctColors >= 4) return last
        await new Promise(r => setTimeout(r, 250))
      }
      return last
    })()`
  )
  console.log(`  preview canvas: ${preview.width}x${preview.height}, ${preview.distinctColors} distinct colours`)
  if (!preview.distinctColors || preview.distinctColors < 4) {
    return fail(`preview did not render a frame (${JSON.stringify(preview)})`)
  }

  /* --- playback -------------------------------------------------------- */
  console.log('\n▶ playback')
  await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().setPlaying(true); true`
  )
  await delay(2000)
  const playing = await win.webContents.executeJavaScript(
    `({ head: window.__clipforgeEditor.getState().playhead })`
  )
  console.log(`  playhead advanced to ${playing.head.toFixed(2)}s`)
  await shot(win, '02-playing')
  await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().setPlaying(false); true`
  )

  /* --- keyframes ------------------------------------------------------- */
  console.log('\n▶ keyframes')
  await win.webContents.executeJavaScript(
    `(() => {
      const store = window.__clipforgeEditor
      const s = store.getState()
      const clipId = s.project.tracks.find(t => t.id === 't_video_1').clips[0].id
      s.setPlayhead(s.project.tracks.find(t => t.id === 't_video_1').clips[0].start + 1)
      s.toggleKeyframe(clipId, 'opacity', 1, 0)
      s.setPlayhead(s.project.tracks.find(t => t.id === 't_video_1').clips[0].start + 2.5)
      s.toggleKeyframe(clipId, 'opacity', 2.5, 1)
      return true
    })()`
  )
  await delay(600)
  await shot(win, '03-keyframes')

  /* --- timeline interaction -------------------------------------------- */
  console.log('\n▶ timeline interaction')

  const geometry = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      const rect = canvas.getBoundingClientRect()
      const track = s.project.tracks.find(t => t.id === 't_video_1')
      const clip = track.clips[1]
      const scroller = document.querySelector('.timeline__scroller')
      const x = clip.start * s.pxPerSecond - scroller.scrollLeft
      return {
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        clipId: clip.id,
        clipStart: clip.start,
        clipDuration: clip.duration,
        pxPerSecond: s.pxPerSecond,
        screenX: rect.left + x + 40,
        // The second video track row starts at rulerH + 1*trackH.
        screenY: rect.top + 26 + 62 + 20
      }
    })()`
  )

  const drag = async (fromX, fromY, toX, toY) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: fromX, y: fromY })
    win.webContents.sendInputEvent({
      type: 'mouseDown', x: fromX, y: fromY, button: 'left', clickCount: 1
    })
    for (let i = 1; i <= 6; i++) {
      const t = i / 6
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(fromX + (toX - fromX) * t),
        y: Math.round(fromY + (toY - fromY) * t),
        button: 'left'
      })
      await delay(30)
    }
    win.webContents.sendInputEvent({
      type: 'mouseUp', x: toX, y: toY, button: 'left', clickCount: 1
    })
    await delay(250)
  }

  // Move the second clip 3 seconds later.
  const before = geometry.clipStart
  await drag(geometry.screenX, geometry.screenY, geometry.screenX + 3 * geometry.pxPerSecond, geometry.screenY)
  const afterMove = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const c = s.project.tracks.find(t => t.id === 't_video_1').clips[1]
      return { start: c.start, selected: s.selectedClipIds }
    })()`
  )
  console.log(`  drag: start ${before.toFixed(2)}s → ${afterMove.start.toFixed(2)}s`)
  if (Math.abs(afterMove.start - (before + 3)) > 0.6) {
    await shot(win, '05-drag-failed')
    return fail(`clip drag did not move the clip (${before} → ${afterMove.start})`)
  }
  if (afterMove.selected.length !== 1) {
    return fail('dragging a clip did not select it')
  }

  // Undo should put it back.
  await win.webContents.executeJavaScript(`window.__clipforgeEditor.getState().undo(); true`)
  await delay(200)
  const afterUndo = await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().project.tracks.find(t => t.id === 't_video_1').clips[1].start`
  )
  console.log(`  undo: start → ${afterUndo.toFixed(2)}s`)
  if (Math.abs(afterUndo - before) > 0.05) {
    return fail(`undo did not restore the clip position (${afterUndo} vs ${before})`)
  }

  await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().select(['${geometry.clipId}']); true`
  )
  await delay(400)
  await shot(win, '05-inspector')

  /* --- export ---------------------------------------------------------- */
  console.log('\n▶ export')
  const outPath = path.join(ROOT, 'testmedia', 'out', 'smoke-export.mp4')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath)

  await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const project = store.getState().project
      await window.clipforge.export.start(project, {
        path: ${JSON.stringify(outPath)},
        preset: 'web',
        kind: 'video'
      })
      return true
    })()`
  )

  const exported = await win.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500))
        const s = window.__clipforgeEditor.getState().exportState
        if (s.status === 'done') return { status: 'done', log: s.log.slice(-6) }
        if (s.status === 'error') return { status: 'error', message: s.message, log: s.log.slice(-12) }
      }
      return { status: 'timeout' }
    })()`
  )

  console.log(`  status=${exported.status}`)
  if (exported.status !== 'done') {
    console.error(exported.message ?? '')
    ;(exported.log ?? []).forEach((l) => console.error('   ', l))
    await shot(win, '04-export-failed')
    return fail(`export did not complete (${exported.status})`)
  }
  ;(exported.log ?? []).forEach((l) => console.log('   ', l))

  await shot(win, '04-export-done')

  const stat = fs.statSync(outPath)
  console.log(`\n✅ export produced ${(stat.size / 1024 / 1024).toFixed(2)} MB at ${outPath}`)

  if (errors.length) {
    console.log('\n⚠ renderer errors:')
    errors.slice(0, 12).forEach((e) => console.log('   ', e))
  } else {
    console.log('\n✅ no renderer errors')
  }

  app.exit(0)
}

run().catch((err) => {
  console.error(err)
  app.exit(1)
})
