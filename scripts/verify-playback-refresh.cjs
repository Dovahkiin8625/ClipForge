/**
 * Checks that the timeline keeps up while the preview is playing.
 *
 * The timeline paints in two layers: a static one (the clips, the waveforms,
 * the selection) and a dynamic one (the playhead, the drag preview). The
 * static layer is only repainted when the document, the selection or the
 * zoom changes — but the playhead moves on every frame of the playback, so
 * the render loop must not be rebuilt for it. When it was, the loop lost
 * every frame it had scheduled and the timeline only woke up again once
 * the playback stopped.
 *
 *   npx electron scripts/verify-playback-refresh.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MEDIA = [
  path.join(ROOT, 'testmedia', 'clip-a.mp4'),
  path.join(ROOT, 'testmedia', 'clip-b.mp4'),
  path.join(ROOT, 'testmedia', 'music.m4a')
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []

function check(label, ok) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  if (!ok) failures.push(label)
}

/**
 * Counts how often each timeline canvas is repainted, so we can see whether
 * the static layer reacts to a change while the preview is playing.
 */
const HOOK = `(() => {
  if (window.__rep) return 'already'
  window.__rep = { static: 0, dyn: 0 }
  const proto = CanvasRenderingContext2D.prototype
  const clear = proto.clearRect
  proto.clearRect = function (...args) {
    const canvases = document.querySelectorAll('.timeline__canvas')
    if (this.canvas === canvases[0]) window.__rep.static++
    else if (this.canvas === canvases[1]) window.__rep.dyn++
    return clear.apply(this, args)
  }
  return 'ok'
})()`

const SNAP = `(() => ({
  rep: window.__rep,
  zoom: window.__clipforgeEditor.getState().pxPerSecond
}))()`

async function run() {
  require(path.join(ROOT, 'out', 'main', 'index.js'))
  await app.whenReady()
  await delay(2500)

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.error('❌ no window was created')
    app.exit(1)
  }
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [console] ${message}`)
  })

  await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      store.getState().addAssets(assets)
      const s = store.getState()
      const video = s.project.tracks.find(t => t.kind === 'video')
      const audio = s.project.tracks.find(t => t.kind === 'audio')
      s.insertClip(assets[0].id, video.id, 0)
      s.insertClip(assets[1].id, video.id, 8)
      s.insertClip(assets[2].id, audio.id, 0)
    })()`
  )
  await delay(2000)
  await win.webContents.executeJavaScript(HOOK)

  const sample = async () => {
    const snap = await win.webContents.executeJavaScript(SNAP)
    console.log(
      `     static repaints=${snap.rep.static} dynamic repaints=${snap.rep.dyn}`
    )
    return snap.rep
  }

  console.log('\n▶ paused')
  const paused = await sample()
  await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().setZoom(window.__clipforgeEditor.getState().pxPerSecond * 1.4)`
  )
  await delay(300)
  const pausedZoom = await sample()
  check('a zoom repaints the timeline while paused', pausedZoom.static > paused.static)

  console.log('\n▶ playing')
  await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().setPlaying(true); window.__clipforgePreview.play()`
  )
  await delay(1500)
  const playing = await sample()

  await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().setZoom(window.__clipforgeEditor.getState().pxPerSecond * 1.4)`
  )
  await delay(1000)
  const zoomed = await sample()
  check('a zoom repaints the timeline while playing', zoomed.static > playing.static)

  await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const clip = s.project.tracks.flatMap(t => t.clips)[0]
      s.select([clip.id])
    })()`
  )
  await delay(600)
  const selected = await sample()
  check('a click repaints the timeline while playing', selected.static > zoomed.static)

  await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const asset = Object.values(s.project.assets)[0]
      const audio = s.project.tracks.find(t => t.kind === 'audio')
      s.insertClip(asset.id, audio.id, 12)
    })()`
  )
  await delay(600)
  const imported = await sample()
  check('an imported clip repaints the timeline while playing', imported.static > selected.static)
  check(
    'the playhead keeps moving while playing',
    imported.dyn > selected.dyn + 30
  )

  await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().setPlaying(false); window.__clipforgePreview.pause()`
  )
  await delay(600)
  await sample()

  console.log('')
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} check(s) failed`)
    app.exit(1)
  }
  console.log('✅ the timeline keeps up during playback')
  app.exit(0)
}

run().catch((e) => {
  console.error(e)
  app.exit(1)
})
