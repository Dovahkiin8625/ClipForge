/** Media-pipeline diagnostic: are the video elements actually loading? */
const { app, BrowserWindow } = require('electron')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MEDIA = [
  path.join(ROOT, 'testmedia', 'clip-a.mp4'),
  path.join(ROOT, 'testmedia', 'music.m4a')
]
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

require(path.join(ROOT, 'out', 'main', 'index.js'))

app.whenReady().then(async () => {
  await delay(2000)
  const win = BrowserWindow.getAllWindows()[0]

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[console:${level}] ${message}`)
  })

  const imported = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      store.getState().pushHistory()
      store.getState().addAssets(assets)
      const s = store.getState()
      s.insertClip(assets[0].id, 't_video_1', 0)
      s.insertClip(assets[1].id, 't_audio_1', 0)
      store.getState().setPlayhead(2.5)
      return assets.map(a => ({ id: a.id, url: a.url, dur: a.duration }))
    })()`
  )
  console.log('imported:', JSON.stringify(imported, null, 2))

  // Can the renderer fetch the media URL directly?
  const fetchResult = await win.webContents.executeJavaScript(
    `(async () => {
      const url = ${JSON.stringify(imported[0].url)}
      try {
        const r = await fetch(url, { headers: { Range: 'bytes=0-1023' } })
        return { status: r.status, type: r.headers.get('content-type'),
                 acao: r.headers.get('access-control-allow-origin'),
                 len: r.headers.get('content-length') }
      } catch (e) { return { error: String(e) } }
    })()`
  )
  console.log('media fetch:', fetchResult)

  await delay(3000)

  const videoState = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('video')).map(v => ({
      src: v.src.slice(0, 60),
      readyState: v.readyState,
      networkState: v.networkState,
      duration: v.duration,
      currentTime: v.currentTime,
      w: v.videoWidth,
      h: v.videoHeight,
      error: v.error ? v.error.code + ':' + v.error.message : null
    }))`
  )
  console.log('video elements:', JSON.stringify(videoState, null, 2))

  const canvasState = await win.webContents.executeJavaScript(
    `(() => {
      const c = document.querySelector('canvas.preview__canvas')
      if (!c) return { error: 'no preview canvas' }
      const ctx = c.getContext('2d')
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      // Count how many distinct colours are present in the frame.
      const seen = new Set()
      for (let i = 0; i < d.length; i += 4 * 977) {
        seen.add(d[i] + ',' + d[i+1] + ',' + d[i+2])
      }
      return { width: c.width, height: c.height, distinctColors: seen.size,
               first: [d[0], d[1], d[2]] }
    })()`
  )
  console.log('preview canvas:', canvasState)

  app.exit(0)
})
