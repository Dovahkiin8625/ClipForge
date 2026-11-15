/**
 * Checks that a still picture put on a video track is actually drawn in the
 * preview: imported as an image, placed on a video track, and its pixels
 * show up on the canvas while the playhead is inside the clip.
 *
 *   npx electron scripts/verify-image-preview.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MEDIA = [
  path.join(ROOT, 'testmedia', 'still-a.png'),
  path.join(ROOT, 'testmedia', 'still-b.jpg')
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []

function check(label, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'}${detail ? ' ' + detail : ''} ${label}`)
  if (!ok) failures.push(label)
}

/**
 * Reads the canvas back and counts the pixels that are not the background.
 */
const COUNT_LIT = `(() => {
  const canvas = document.querySelector('canvas.preview__canvas')
  const bg = window.__clipforgeEditor.getState().project.settings.background
  const hex = bg.replace('#', '')
  const bgPx = [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16)
  ]
  const ctx = canvas.getContext('2d')
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let lit = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== bgPx[0] || data[i + 1] !== bgPx[1] || data[i + 2] !== bgPx[2]) lit++
  }
  return { lit, total: data.length / 4 }
})()`

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
    })()`
  )
  await delay(1500)

  const assets = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      return Object.values(s.project.assets).map((a) => ({
        id: a.id, kind: a.kind, name: a.name, w: a.width, h: a.height, duration: a.duration
      }))
    })()`
  )
  console.log('  assets:', JSON.stringify(assets))

  check('the PNG is imported as an image', assets[0] && assets[0].kind === 'image', assets[0] && assets[0].kind)
  check('the JPEG is imported as an image', assets[1] && assets[1].kind === 'image', assets[1] && assets[1].kind)
  check('the picture knows its size', assets[0] && assets[0].w === 640 && assets[0].h === 360)

  // Put both pictures on a video track, one after the other.
  await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const trackId = s.ensureTrack('video')
      const ids = ${JSON.stringify(assets.map((a) => a.id))}
      s.insertClip(ids[0], trackId, 0)
      s.insertClip(ids[1], trackId, 6)
    })()`
  )
  await delay(1200)

  const clips = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      return s.project.tracks
        .flatMap((t) => t.clips)
        .map((c) => ({ start: c.start, duration: c.duration, assetId: c.assetId }))
    })()`
  )
  console.log('  clips:', JSON.stringify(clips))
  check('the pictures are on the timeline', clips.length === 2)
  check(
    'the picture keeps its length',
    clips[0] && clips[0].duration === 5,
    clips[0] && String(clips[0].duration)
  )

  // --- the picture has to be on the canvas ------------------------------

  const at = async (time) => {
    await win.webContents.executeJavaScript(
      `window.__clipforgePreview.seek(${time})`
    )
    // A picture that has not been decoded yet is painted as soon as it
    // arrives, so the canvas is read a moment later.
    await delay(600)
    return win.webContents.executeJavaScript(COUNT_LIT)
  }

  const first = await at(1)
  console.log('  canvas at 1s:', JSON.stringify(first))
  check(
    'the picture is drawn on the preview canvas',
    first.lit > first.total * 0.5,
    `${first.lit}/${first.total} pixels`
  )

  const second = await at(7)
  console.log('  canvas at 7s:', JSON.stringify(second))
  check(
    'the second picture is drawn too',
    second.lit > second.total * 0.5,
    `${second.lit}/${second.total} pixels`
  )

  // Between the two pictures there is nothing but the background.
  const gap = await at(5.5)
  console.log('  canvas in the gap:', JSON.stringify(gap))
  check(
    'the gap between the pictures stays empty',
    gap.lit === 0,
    `${gap.lit}/${gap.total} pixels`
  )

  console.log('')
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} check(s) failed`)
    app.exit(1)
  }
  console.log('✅ still pictures are drawn in the preview')
  app.exit(0)
}

run().catch((e) => {
  console.error(e)
  app.exit(1)
})
